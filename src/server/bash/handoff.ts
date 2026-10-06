// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's /tmp is its own session's scratch, so no mount or kept
// file learns a second session: its parent's copied in at its start,
// and what it added or changed copied back under the parent's
// /tmp/<folder>/ at its end, within the parent's caps.

import { type Db, transact } from "../db/index.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { checkScratchNames, isScratchName, mountableScratch } from "./names.ts";
import { acquireSession } from "./queue.ts";
import type { ScratchFile, ScratchStore } from "./scratch.ts";

// each copied file's bytes and mode, by path, as the child began
export type ScratchBaseline = ReadonlyMap<string, string>;

export type Returned = {
  // the parent's paths, under /tmp
  copied: string[];
  // the child's paths that did not fit or could not be named there
  left: string[];
};

const digest = (file: ScratchFile) =>
  `${file.mode}:${Bun.hash(file.data).toString(36)}`;

const sizeOf = (path: string, bytes: number) => bytes + Buffer.byteLength(path);

// the first sub-N no file of the parent's /tmp stands at or under, and
// none taken by a sibling of the same send
export function scratchFolder(
  store: ScratchStore,
  sessionId: string,
  taken: ReadonlySet<string>,
): string {
  const tops = new Set(
    store.sizes(sessionId).map((file) => file.path.split("/")[0]!),
  );
  for (let n = 1; ; n++) {
    const name = `sub-${n}`;
    if (!tops.has(name) && !taken.has(name)) return name;
  }
}

// the parent's mountable files become the child's, which starts in /tmp
export function copyIn(
  db: Db,
  store: ScratchStore,
  from: string,
  to: string,
  now: number,
): ScratchBaseline {
  const files = mountableScratch(store.read(from).entries).kept;
  transact(db, () => {
    store.write(to, 0, { written: files, removed: [], cwd: "/tmp" }, now);
    return { result: undefined, events: [] };
  });
  return new Map(files.map((file) => [file.path, digest(file)]));
}

// under the parent's command queue, so none of its commands commits
// between the read and the write; a file that does not fit the
// parent's caps or name rule is left and named. The child's scratch
// goes in the same transaction, since a child is never continued
export async function copyBack(
  deps: { db: Db; store: ScratchStore; current(): KnowledgeCaps },
  child: string,
  parent: string,
  folder: string,
  baseline: ScratchBaseline,
  now: number,
): Promise<Returned> {
  const release = await acquireSession(parent, new AbortController().signal);
  try {
    return transact(deps.db, () => {
      const result = backInto(deps, child, parent, folder, baseline, now);
      deps.store.drop(child);
      return { result, events: [] };
    });
  } finally {
    release();
  }
}

// the changed files under the parent's folder, as many as fit
function backInto(
  deps: { store: ScratchStore; current(): KnowledgeCaps },
  child: string,
  parent: string,
  folder: string,
  baseline: ScratchBaseline,
  now: number,
): Returned {
  const changed = mountableScratch(deps.store.read(child).entries).kept.filter(
    (file) => baseline.get(file.path) !== digest(file),
  );
  if (changed.length === 0) return { copied: [], left: [] };
  const theirs = deps.store.read(parent);
  const caps = deps.current();
  const held = new Map(
    theirs.entries.map((file) => [
      file.path,
      sizeOf(file.path, file.data.byteLength),
    ]),
  );
  let files = held.size;
  let bytes = [...held.values()].reduce((sum, size) => sum + size, 0);
  const written: ScratchFile[] = [];
  const left: string[] = [];
  for (const file of changed) {
    const path = `${folder}/${file.path}`;
    const size = sizeOf(path, file.data.byteLength);
    const before = held.get(path);
    const nextFiles = files + (before === undefined ? 1 : 0);
    const nextBytes = bytes - (before ?? 0) + size;
    if (
      held.has(folder) ||
      !isScratchName(path) ||
      nextFiles > caps.scratchFiles ||
      nextBytes > caps.scratchBytes
    ) {
      left.push(file.path);
      continue;
    }
    files = nextFiles;
    bytes = nextBytes;
    held.set(path, size);
    written.push({ ...file, path });
  }
  try {
    checkScratchNames([...held.keys()]);
  } catch {
    // a file of the parent's stands where a folder would go
    return { copied: [], left: changed.map((file) => file.path) };
  }
  if (written.length > 0) {
    deps.store.write(
      parent,
      theirs.revision,
      { written, removed: [], cwd: theirs.cwd },
      now,
    );
  }
  return { copied: written.map((file) => `/tmp/${file.path}`), left };
}
