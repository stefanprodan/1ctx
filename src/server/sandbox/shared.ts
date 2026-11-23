// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One sandbox shared by a chat's commands and its subagents', which run
// at once while their pushes and saves take turns. The base is what the
// sandbox held at the last push or save, as the server knows it. A
// push brings the rows in, but /knowledge only while no other command
// with docs runs, since one may be midway through a change there. A save takes
// every /knowledge file that differs from the base as the sandbox's own
// change, whichever command made it, and reads it against the rows as
// they stand now: a file the rows moved since the base was changed by
// someone else, so the save refuses as a commit would; any other file
// is taken as the rows hold it, and the put-back brings it in. /mcp
// holds the kept files of every workspace with a command running, and
// the root's, each owned by its workspace.

import { textFromBytes } from "../../shared/knowledge.ts";
import type { Job, TreeEntry } from "../bash/index.ts";
import { underKnowledge } from "../bash/index.ts";
import { checkFile } from "../knowledge/index.ts";
import { parseName } from "../knowledge/rules.ts";
import {
  FILE_MODE,
  type FileNode,
  type Held,
  type Tree,
  type Wanted,
  withFolders,
} from "./baseline.ts";
import type { PushManifest } from "./frames.ts";
import type { Readout } from "./readout.ts";

export type Shared = {
  // null before the first push
  base: Tree | null;
  // one more at each change of the base, so a command knows whether
  // another's push or save came after what it read of the rows
  version: number;
  // each /mcp file's workspace
  owners: Map<string, string>;
  // a step failed or a holder recycled: nothing more is pushed or saved
  broken: boolean;
  // the workspaces with a command running, by count
  running: Map<string, number>;
  // the commands that entered the sandbox, and those of them with docs:
  // a holder that gave up before its push never runs there
  entered: number;
  docs: number;
  // each doc a put-back took from another chat's rows, at the base's
  // version it made, with what it wrote (null for a delete)
  imported: Map<string, { version: number; sha: string | null }>;
  // the base's version each command with docs pushed at: a change in
  // the sandbox may be any of theirs. One that ended unfenced stays
  // until a fence or the sandbox goes, since what it started may run on
  pushes: Map<object, number>;
};

export function sharedOf(synced: { value: unknown }): Shared {
  synced.value ??= {
    base: null,
    version: 0,
    owners: new Map(),
    broken: false,
    running: new Map(),
    entered: 0,
    docs: 0,
    imported: new Map(),
    pushes: new Map(),
  } satisfies Shared;
  return synced.value as Shared;
}

export function enter(
  shared: Shared,
  workspace: string,
  docs: boolean,
): { leave(): void; pushed(version: number): void; fenced(): void } {
  shared.running.set(workspace, (shared.running.get(workspace) ?? 0) + 1);
  shared.entered++;
  if (docs) shared.docs++;
  const me = {};
  let left = false;
  // what ended before this command's fence, which stopped every process:
  // judged by its save, then never written to again
  let fenced: object[] = [];
  return {
    pushed(version) {
      if (docs && !left) shared.pushes.set(me, version);
    },
    fenced() {
      fenced = [...shared.pushes.keys(), me];
    },
    leave() {
      if (left) return;
      left = true;
      shared.entered--;
      if (docs) shared.docs--;
      for (const key of fenced) shared.pushes.delete(key);
      const n = (shared.running.get(workspace) ?? 1) - 1;
      if (n > 0) shared.running.set(workspace, n);
      else shared.running.delete(workspace);
    },
  };
}

// the oldest push among the commands with docs that may still write,
// since a save takes every one's change and any may have read before an
// import
export const oldestPush = (shared: Shared, own: number) =>
  Math.min(own, ...shared.pushes.values());

// no other command entered the sandbox, so none runs beside this one
export const alone = (shared: Shared) => shared.entered <= 1;

const kept = (path: string) => path.startsWith("/mcp/");

// What the sandbox holds after a command's push: its job's uploads and
// kept files, its docs (none when they are off) only when no other
// command with docs runs, else the base's, and the kept files of other
// workspaces still running or the root's.
export function pushTarget(
  shared: Shared,
  wanted: Wanted,
  me: string,
  root: string,
  docs: boolean,
): { target: Wanted; owners: Map<string, string> } {
  const owners = new Map<string, string>();
  for (const [path, node] of wanted.tree)
    if (node.kind === "file" && kept(path)) owners.set(path, me);
  // another command with docs may be midway through a change there
  const keep = shared.docs - (docs ? 1 : 0) > 0;
  // no one runs who pushed before what a put-back took from the rows
  if (!keep) shared.imported.clear();
  const base = shared.base;
  if (base === null) return { target: wanted, owners };
  const tree: Tree = new Map();
  for (const [path, node] of wanted.tree) {
    if (node.kind !== "file") continue;
    if (keep && underKnowledge(path)) continue;
    tree.set(path, node);
  }
  for (const [path, node] of base) {
    if (node.kind !== "file" || tree.has(path)) continue;
    if (keep && underKnowledge(path)) tree.set(path, node);
    if (!kept(path)) continue;
    const owner = shared.owners.get(path);
    if (owner === undefined || owner === me) continue;
    if (owner !== root && !shared.running.has(owner)) continue;
    tree.set(path, node);
    owners.set(path, owner);
  }
  return { target: { tree: withFolders(tree), bytes: wanted.bytes }, owners };
}

// The job's tree with its docs as the rows hold them now: a command
// that waited for the sandbox's turn may have read them before a save
// moved them, and a push must never take the sandbox back.
export function withDocs(wanted: Wanted, docs: Wanted): Wanted {
  const tree: Tree = new Map();
  for (const [path, node] of wanted.tree)
    if (node.kind === "file" && !underKnowledge(path)) tree.set(path, node);
  for (const [path, node] of docs.tree)
    if (node.kind === "file") tree.set(path, node);
  const bytes = new Map(wanted.bytes);
  for (const [path, data] of docs.bytes) bytes.set(path, data);
  return { tree: withFolders(tree), bytes };
}

// a tree without /knowledge, for a save that leaves it to another
export const outsideKnowledge = (tree: Tree): Tree =>
  new Map([...tree].filter(([path]) => !underKnowledge(path)));

// the /mcp files of every workspace, which the read back must not take
// for a command's changes
export const keptPaths = (base: Tree) =>
  [...base].flatMap(([path, node]) =>
    node.kind === "file" && kept(path) ? [path] : [],
  );

// what a doc's file is, or null for none
const fileOf = (tree: Tree, path: string): FileNode | null => {
  const node = tree.get(path);
  return node?.kind === "file" ? node : null;
};

// a path at or under one left in place, asked of its ancestors so a
// walk's every entry costs its depth, never the set's size
export function within(left: ReadonlySet<string>, path: string): boolean {
  if (left.size === 0) return false;
  for (let at = path; at !== ""; at = at.slice(0, at.lastIndexOf("/")))
    if (left.has(at)) return true;
  return false;
}

// The /knowledge entries a save leaves in place while other commands
// hold the sandbox: a link, a special file, a name the rules refuse, or
// a changed doc that is not text or is past the file cap, any of which
// may be a running command's work in progress. Alone, they refuse the
// save as the rules say.
export function leftInPlace(
  read: Readout,
  base: Tree,
  fresh: Wanted,
  caps: { knowledgeFileBytes: number },
): Set<string> {
  // what moved under the walk or before the pull is never read
  const left = new Set(read.moved);
  for (const entry of read.entries) {
    if (!underKnowledge(entry.path) || within(left, entry.path)) continue;
    if (entry.kind === "link" || entry.kind === "other") {
      left.add(entry.path);
      continue;
    }
    if (entry.kind !== "file") continue;
    try {
      parseName(entry.path.slice("/knowledge/".length));
    } catch {
      left.add(entry.path);
      continue;
    }
    const held = read.held.get(entry.path);
    const was = fileOf(base, entry.path);
    if (held?.kind !== "file" || was?.sha === held.sha) continue;
    if (refusedOnItsOwn(entry, fresh, caps)) left.add(entry.path);
  }
  return left;
}

// a doc a rule refuses on its own, as the read back reads it: not text,
// or past the file cap
function refusedOnItsOwn(
  entry: TreeEntry,
  fresh: Wanted,
  caps: { knowledgeFileBytes: number },
): boolean {
  const before = fileOf(fresh.tree, entry.path)?.size ?? 0;
  try {
    const text = textFromBytes(entry.bytes ?? new Uint8Array());
    checkFile(entry.path, Buffer.byteLength(text), before, caps);
    return false;
  } catch {
    return true;
  }
}

// Each doc as the save reads it: a file that differs from the base is
// the sandbox's change, read against the rows unless they moved since
// the base, which refuses; every other file is the rows' now. A change
// that matches the rows' bytes refuses nothing. What is left in place
// is no change: the rows' file stands there. A change to a doc a
// put-back took from another chat's rows after the oldest running push
// may be made against what it held before, so it refuses too.
export function againstRows(
  read: Readout,
  base: Tree,
  fresh: Wanted,
  left: ReadonlySet<string> = new Set(),
  since: { imported: Shared["imported"]; pushed: number } = {
    imported: new Map(),
    pushed: 0,
  },
): { entries: TreeEntry[]; conflicts: string[] } {
  const paths = new Set<string>();
  for (const tree of [base, fresh.tree, read.held])
    for (const path of tree.keys()) if (underKnowledge(path)) paths.add(path);
  const changed = new Set<string>();
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    if (within(left, path)) continue;
    const was = fileOf(base, path);
    const now = fileOf(fresh.tree, path);
    const node = read.held.get(path);
    const file = node?.kind === "file" ? (node.sha ?? null) : undefined;
    // a folder or link where the rows now hold a file is a change too
    const ours =
      file !== undefined
        ? was === null || was.sha !== file
        : was !== null || (node !== undefined && now !== null);
    if (!ours) continue;
    changed.add(path);
    const taken = since.imported.get(path);
    if (
      taken !== undefined &&
      taken.version > since.pushed &&
      taken.sha !== (file ?? null)
    ) {
      conflicts.push(path);
      continue;
    }
    if ((was?.key ?? null) === (now?.key ?? null)) continue;
    // the same bytes, or both gone, change nothing
    if (file !== undefined ? now?.sha === file : now === null) continue;
    conflicts.push(path);
  }
  const entries = read.entries.filter(
    (entry) =>
      !underKnowledge(entry.path) ||
      (!within(left, entry.path) &&
        (entry.kind !== "file" || changed.has(entry.path))),
  );
  const listed = new Set(entries.map((entry) => entry.path));
  for (const [path, node] of fresh.tree) {
    if (node.kind !== "file" || changed.has(path) || listed.has(path)) continue;
    entries.push({
      path,
      kind: "file",
      mode: FILE_MODE,
      bytes: fresh.bytes.get(path),
    });
  }
  return { entries, conflicts };
}

// The put-back of only some paths: what reaches them, and the base
// after, those as the rows hold them and every other as it was, since
// the sandbox still holds its change for a later save
export function onlyPaths(
  manifest: PushManifest,
  only: ReadonlySet<string>,
): PushManifest {
  const near = (path: string) =>
    only.has(path) || [...only].some((at) => at.startsWith(`${path}/`));
  return {
    remove: (manifest.remove ?? []).filter((path) => within(only, path)),
    folders: (manifest.folders ?? []).filter((at) => near(at.path)),
    files: (manifest.files ?? []).filter((at) => only.has(at.path)),
    meta: (manifest.meta ?? []).filter((at) => near(at.path)),
  };
}

export function onlyBase(
  base: Tree,
  after: Tree,
  only: ReadonlySet<string>,
): Tree {
  const tree: Tree = new Map();
  for (const [path, node] of base)
    if (node.kind === "file" && !only.has(path)) tree.set(path, node);
  for (const path of only) {
    const node = after.get(path);
    if (node?.kind === "file") tree.set(path, node);
  }
  return withFolders(tree);
}

// what a put-back takes from another chat's rows: a doc whose row moved
// since the base and that this save did not write, so a command that
// pushed before it cannot save over it unseen
export function noteImports(
  shared: Shared,
  base: Tree,
  after: Tree,
  written: ReadonlySet<string>,
  paths: ReadonlySet<string> | null,
): void {
  const version = shared.version + 1;
  const all = new Set<string>();
  for (const tree of [base, after])
    for (const [path, node] of tree)
      if (node.kind === "file" && underKnowledge(path)) all.add(path);
  for (const path of all) {
    if (written.has(path) || (paths !== null && !paths.has(path))) continue;
    const was = fileOf(base, path);
    const now = fileOf(after, path);
    if ((was?.key ?? null) === (now?.key ?? null)) continue;
    shared.imported.set(path, { version, sha: now?.sha ?? null });
  }
}

// the words a save refused over moved docs ends with; beside other
// commands only those are put back, the rest left for a later save
export function conflictWords(conflicts: readonly string[], alone: boolean) {
  const name = conflicts[0]!.slice("/knowledge/".length);
  const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : "";
  return alone
    ? `${name}${more} changed while the command ran, read it again`
    : `${name}${more} changed while the command ran, so ${conflicts.length > 1 ? "they were" : "it was"} put back; read it again and retry. ${OTHERS_STAY}`;
}

const OTHERS_STAY = "Other changes stay in the sandbox for a later save.";

// the words a refusal beside other commands ends with: nothing is put
// back, since a running command's work may be among the changes
export const keptForLater = (refused: string) =>
  `${refused}, so nothing was saved. The changes stay in the sandbox for a later save.`;

// The put-back's frames while other commands hold the sandbox: what
// is left in place stays, and so does every folder, which a running
// command may be about to write in. Each file it writes or removes
// holds to what the walk read there, so one a running command wrote
// since stays for a later save, the base saying otherwise.
export function spared(
  manifest: PushManifest,
  held: Held,
  left: ReadonlySet<string>,
  alone: boolean,
): PushManifest {
  const folder = (path: string) => !alone && held.get(path)?.kind === "dir";
  const kept = (path: string) => !within(left, path) && !folder(path);
  const remove = (manifest.remove ?? []).filter(kept);
  const folders = (manifest.folders ?? []).filter((at) => kept(at.path));
  const files = (manifest.files ?? []).filter((at) => kept(at.path));
  const meta = (manifest.meta ?? []).filter((at) => !within(left, at.path));
  // a folder kept with a change in it still needs its mode for the frame
  const settled = new Set([...folders, ...meta].map((at) => at.path));
  const gone = new Set(remove);
  for (const path of [...remove, ...files.map((at) => at.path)]) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    const node = held.get(parent);
    if (node?.kind !== "dir" || settled.has(parent) || gone.has(parent))
      continue;
    settled.add(parent);
    meta.push({ path: parent, mode: node.mode, mtime: node.mtime ?? 0 });
  }
  if (alone) return { remove, folders, files, meta };
  const was = new Map<string, string | null>();
  for (const path of [...remove, ...files.map((at) => at.path)]) {
    const node = held.get(path);
    if (node === undefined) was.set(path, null);
    else if (node.kind === "file" && node.sha) was.set(path, node.sha);
  }
  return { remove, folders, files, meta, was };
}

// the job the read back judges: the rows' docs now, every kept file in
// the sandbox, and a subagent's change to /knowledge allowed
export function savedJob(job: Job, docs: Job["knowledge"], base: Tree): Job {
  const { subagent: _, ...rest } = job;
  return { ...rest, knowledge: [...docs], kept: keptPaths(base) };
}

// the tree the put-back starts from: the rows' docs now, the base's
// uploads and kept files
export function freshTree(base: Tree, fresh: Wanted, bytes: Wanted["bytes"]) {
  const tree: Tree = new Map();
  for (const [path, node] of base)
    if (node.kind === "file" && !underKnowledge(path)) tree.set(path, node);
  for (const [path, node] of fresh.tree)
    if (node.kind === "file") tree.set(path, node);
  const all = new Map(bytes);
  for (const [path, data] of fresh.bytes) all.set(path, data);
  return { tree: withFolders(tree), bytes: all };
}
