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
  bytes: number;
  // files past fileBytes, kept and unreadable
  large: number;
  // files and links the ignore rules kept out
  ignored: number;
  // links out of the tree, hard links to nothing kept, other members
  dropped: number;
};

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
        meta.bytes,
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
