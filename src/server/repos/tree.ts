// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A published tree on disk: its folder in the cache and its tree.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCommit } from "./adapters.ts";

// tree.json: what a published folder holds
export type TreeMeta = {
  commit: string;
  // the commit's time, seconds since the epoch
  time: number;
  files: number;
  // the folders under files/, which a walk visits as it does files
  dirs: number;
  bytes: number;
  // what the cache counts toward repoCacheBytes: each kept file rounded
  // up to whole blocks, an empty one a block, and a block per folder and
  // link, so a tree of empty files still costs what it takes
  disk: number;
  // files past fileBytes, kept and unreadable
  large: number;
  // files and links the ignore rules kept out
  ignored: number;
  // links out of the tree, hard links to nothing kept, other members
  dropped: number;
};

// a volume's usual allocation unit
export const BLOCK = 4096;
// what a file takes on disk in whole blocks; an empty one, a folder or a
// link (onDisk(0)) still takes one
export const onDisk = (bytes: number) =>
  Math.max(1, Math.ceil(bytes / BLOCK)) * BLOCK;

export const treesDir = (cacheDir: string) => join(cacheDir, "trees");
export const tmpDir = (cacheDir: string) => join(cacheDir, "tmp");
export const treeFolder = (
  cacheDir: string,
  source: string,
  commit: string,
  ignoreKey: string,
) => join(treesDir(cacheDir), source, `${commit}-${ignoreKey}`);

export function readMeta(folder: string): TreeMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(folder, "tree.json"), "utf8"));
    if (
      typeof meta !== "object" ||
      meta === null ||
      !isCommit(meta.commit) ||
      ![
        meta.time,
        meta.files,
        meta.dirs,
        meta.bytes,
        meta.disk,
        meta.large,
        meta.ignored,
        meta.dropped,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      return null;
    }
    return meta as TreeMeta;
  } catch {
    return null;
  }
}
