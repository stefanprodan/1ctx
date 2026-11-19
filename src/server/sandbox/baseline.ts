// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a sandbox's trees hold, as the server knows it: what was pushed
// and what committed, never read back from the sandbox. A command's
// rows become the tree it wants; the difference from what the sandbox
// holds is the push, and after a commit the walked tree is put back to
// the stored one, so a warm sandbox and a rebuilt one hold the same.

import type { Job, Mounted, SettleOutcome } from "../bash/index.ts";
import { prefixes } from "../bash/index.ts";
import type { PushFile, PushFolder, PushManifest } from "./frames.ts";
import { SANDBOX_ROOTS } from "./frames.ts";

// the modes just-bash gives a folder and a file it writes without one
export const FOLDER_MODE = 0o755;
export const FILE_MODE = 0o644;

export type FileNode = {
  kind: "file";
  mode: number;
  mtime: number;
  sha: string;
  size: number;
  // the identity the bytes came from: the same key, the same bytes, so
  // a file is hashed only when its row changed
  key: string | null;
};
export type DirNode = { kind: "dir"; mode: number; mtime: number };
export type Node = FileNode | DirNode;
// every path under the roots, never a root itself
export type Tree = Map<string, Node>;

export type Wanted = {
  tree: Tree;
  // the bytes of every file the job carries, and of a kept file read
  bytes: Map<string, Uint8Array>;
};

// what a tree holds now; null mtime when it was walked, not pushed
export type Held = Map<
  string,
  {
    kind: "file" | "dir" | "link" | "other";
    mode: number;
    mtime: number | null;
    sha?: string | null;
  }
>;

// a doc's bytes by its row: the same id and revision, the same bytes
export const docKey = (id: string, revision: number) => `d:${id}:${revision}`;

export const sha256 = (data: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

type Source = {
  path: string;
  mode: number;
  mtime: number;
  key: string | null;
  data?: Uint8Array;
  read?: () => Uint8Array;
  // a hash already known for these bytes
  known?: { sha: string; size: number };
};

// a folder takes its newest file's time, as command.worker.ts sets it
export function withFolders(tree: Tree): Tree {
  const times = new Map<string, number>();
  for (const [path, node] of tree) {
    if (node.kind !== "file") continue;
    for (const folder of prefixes(path).slice(1, -1))
      times.set(folder, Math.max(times.get(folder) ?? 0, node.mtime));
  }
  for (const [path, mtime] of times)
    tree.set(path, { kind: "dir", mode: FOLDER_MODE, mtime });
  return tree;
}

function place(wanted: Wanted, files: Source[], before: Tree | null): void {
  for (const file of files) {
    const old = before?.get(file.path);
    let data = file.data;
    let sha: string;
    let size: number;
    if (file.known !== undefined) {
      sha = file.known.sha;
      size = file.known.size;
    } else if (
      old?.kind === "file" &&
      file.key !== null &&
      old.key === file.key
    ) {
      sha = old.sha;
      size = old.size;
    } else {
      data ??= file.read?.() ?? new Uint8Array();
      sha = sha256(data);
      size = data.byteLength;
    }
    if (data !== undefined) wanted.bytes.set(file.path, data);
    wanted.tree.set(file.path, {
      kind: "file",
      mode: file.mode,
      mtime: file.mtime,
      sha,
      size,
      key: file.key,
    });
  }
}

// the words a command that read a kept file the store could not give
// back ends with, as the builtin shell's worker answers
export const KEPT_FAILED = "the kept file could not be read";

// a kept file the store could not read: the command does not run, so
// nothing saves, as when just-bash's lazy read fails
export class KeptUnreadable extends Error {
  constructor() {
    super(KEPT_FAILED);
  }
}

// The tree a job's rows make, its files hashed only where their key
// differs from what the sandbox holds. A kept file is read only then.
export function wantedOf(
  job: Job,
  mounted: Mounted,
  kept: (index: number) => Uint8Array | null,
  before: Tree | null,
): Wanted {
  const wanted: Wanted = { tree: new Map(), bytes: new Map() };
  const uploadsKey = `u:${mounted.uploads.sessionId}:${mounted.uploads.revision}`;
  const files: Source[] = [
    ...job.knowledge.map((file, index) => {
      const row = mounted.docs[index];
      return {
        path: `/knowledge/${file.name}`,
        mode: FILE_MODE,
        mtime: file.mtime,
        key: row?.name === file.name ? docKey(row.id, row.revision) : null,
        data: file.data,
      };
    }),
    ...job.uploads.map((file) => ({
      path: `/uploads/${file.name}`,
      mode: FILE_MODE,
      mtime: file.mtime,
      key: uploadsKey,
      data: file.data,
    })),
    ...job.kept.map((path, index) => {
      const row = mounted.kept[index];
      return {
        path,
        mode: FILE_MODE,
        mtime: 0,
        key:
          row === undefined
            ? null
            : `k:${row.messageId}:${row.position}:${row.bytes}`,
        // a row gone since the mount is unreadable: the push is eager,
        // so an empty file would stand in for bytes nobody asked for
        read: () => {
          let data: Uint8Array | null;
          try {
            data = kept(index);
          } catch {
            throw new KeptUnreadable();
          }
          if (data === null) throw new KeptUnreadable();
          return data;
        },
      };
    }),
  ];
  place(wanted, files, before);
  withFolders(wanted.tree);
  return wanted;
}

// The docs as the rows hold them now, each keyed by its id and
// revision, hashed only where the key differs from what is held.
export function docsWanted(
  docs: readonly {
    id: string;
    name: string;
    revision: number;
    updatedAt: number;
    data: Uint8Array;
  }[],
  before: Tree | null,
): Wanted {
  const wanted: Wanted = { tree: new Map(), bytes: new Map() };
  place(
    wanted,
    docs.map((doc) => ({
      path: `/knowledge/${doc.name}`,
      mode: FILE_MODE,
      mtime: doc.updatedAt,
      key: docKey(doc.id, doc.revision),
      data: doc.data,
    })),
    before,
  );
  return wanted;
}

type Landed = Extract<SettleOutcome, { landed: true }>;

// The tree after a landed commit: each doc the commit wrote as it
// stored it (its text, which may drop a BOM, and its time), folders
// rebuilt from the files, so an empty folder goes. /uploads and /mcp
// stay as they were.
export function committedTree(wanted: Wanted, written: Landed["docs"]): Wanted {
  const out: Wanted = { tree: new Map(), bytes: new Map() };
  const encoder = new TextEncoder();
  const files: Source[] = [];
  for (const [path, node] of wanted.tree) {
    if (node.kind !== "file") continue;
    if (path.startsWith("/knowledge/")) continue;
    out.tree.set(path, node);
    const data = wanted.bytes.get(path);
    if (data !== undefined) out.bytes.set(path, data);
  }
  const docs = new Map<string, Source>();
  for (const [path, node] of wanted.tree) {
    if (node.kind !== "file" || !path.startsWith("/knowledge/")) continue;
    docs.set(path, {
      path,
      mode: node.mode,
      mtime: node.mtime,
      key: node.key,
      data: wanted.bytes.get(path),
      known: node,
    });
  }
  for (const doc of written) {
    const path = `/knowledge/${doc.name}`;
    if (doc.text === null) docs.delete(path);
    else
      docs.set(path, {
        path,
        mode: FILE_MODE,
        mtime: doc.updatedAt,
        key: docKey(doc.id, doc.revision),
        data: encoder.encode(doc.text),
      });
  }
  files.push(...docs.values());
  place(out, files, null);
  withFolders(out.tree);
  return out;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

// The frames that turn what a tree holds into what is wanted, under the
// roots given. A path wanted and held alike is left alone, or given its
// mode and time when only those differ; a held mtime of null (a walked
// tree) always takes the wanted one. Every folder holding a change gets
// its mode and time, which a write moves.
export function manifestOf(
  held: Held,
  wanted: Wanted,
  roots: readonly string[] = SANDBOX_ROOTS,
): PushManifest {
  const within = (path: string) =>
    roots.some((root) => path.startsWith(`${root}/`));
  const remove: string[] = [];
  const folders: PushFolder[] = [];
  const files: PushFile[] = [];
  const meta = new Map<string, PushFolder>();
  const changed: string[] = [];
  for (const [path, node] of held) {
    if (!within(path)) continue;
    const want = wanted.tree.get(path);
    if (want === undefined || want.kind !== node.kind) {
      remove.push(path);
      changed.push(path);
    }
  }
  const removed = new Set(remove);
  for (const [path, want] of wanted.tree) {
    if (!within(path)) continue;
    const have = held.get(path);
    const same = have !== undefined && have.kind === want.kind;
    const settled =
      same && have.mode === want.mode && have.mtime === want.mtime;
    const entry = { path, mode: want.mode, mtime: want.mtime };
    if (want.kind === "dir") {
      if (!same) {
        folders.push(entry);
        changed.push(path);
      } else if (!settled) meta.set(path, entry);
      continue;
    }
    if (!same || have.sha !== want.sha) {
      const data = wanted.bytes.get(path);
      if (data === undefined) throw new Error("a wanted file has no bytes");
      files.push({ ...entry, data });
      changed.push(path);
    } else if (!settled) meta.set(path, entry);
  }
  const made = new Set(folders.map((folder) => folder.path));
  for (const path of changed) {
    const parent = parentOf(path);
    if (roots.includes(parent) || removed.has(parent) || made.has(parent))
      continue;
    const want = wanted.tree.get(parent);
    if (want?.kind === "dir")
      meta.set(parent, { path: parent, mode: want.mode, mtime: want.mtime });
  }
  return { remove, folders, files, meta: [...meta.values()] };
}

export const emptyManifest = (manifest: PushManifest) =>
  (manifest.remove?.length ?? 0) +
    (manifest.folders?.length ?? 0) +
    (manifest.files?.length ?? 0) +
    (manifest.meta?.length ?? 0) ===
  0;

// what each root held, for the walk's bounds: a lowered cap still lets
// a command shrink what is there
export function heldSizes(tree: Tree | null) {
  const out = { entries: 0, largest: 0, bytes: new Map<string, number>() };
  for (const [path, node] of tree ?? []) {
    out.entries++;
    if (node.kind !== "file") continue;
    out.largest = Math.max(out.largest, node.size);
    const root = `/${path.split("/")[1]}`;
    out.bytes.set(root, (out.bytes.get(root) ?? 0) + node.size);
  }
  return out;
}
