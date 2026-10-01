// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cache directory: trees/<source>/<commit>-<ignore>/ per tree,
// tmp/ for the jobs unpacking. An index in memory holds each tree's
// bytes and when it was last mounted; a folder mounted by a running turn
// is held and never evicted. The trees can always be fetched again, so
// backups leave the directory out.

import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";
import {
  readMeta,
  type TreeMeta,
  tmpDir,
  treeFolder,
  treesDir,
} from "./tree.ts";

// what a fetch leaves free on the cache's volume, beyond repoBytes
export const REPO_FREE_BYTES = 1024 * 1024 * 1024;
// a mount moves a folder's time on disk at most this often
const TOUCH_MS = 60 * 60 * 1000;

export type CacheEntry = {
  // the tree's folder; bash mounts its files/
  folder: string;
  meta: TreeMeta;
  lastRead: number;
};

export type FreeSpace = (dir: string) => number;

const freeSpace: FreeSpace = (dir) => {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
};

export type Swept = { trees: number; bytes: number; tmp: number };

export class RepoCache {
  private readonly index = new Map<string, CacheEntry>();
  private readonly holds = new Map<string, number>();
  private readonly touched = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly clock: Clock,
    private readonly free: FreeSpace = freeSpace,
  ) {}

  // at startup: the folders made, tmp/ cleared, every tree indexed
  start(): { trees: number; bytes: number } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    rmSync(tmpDir(this.dir), { recursive: true, force: true });
    mkdirSync(tmpDir(this.dir), { mode: 0o700 });
    mkdirSync(treesDir(this.dir), { recursive: true, mode: 0o700 });
    this.index.clear();
    for (const source of readdirSync(treesDir(this.dir))) {
      const sourceDir = join(treesDir(this.dir), source);
      let names: string[];
      try {
        names = readdirSync(sourceDir);
      } catch {
        continue;
      }
      for (const name of names) {
        const folder = join(sourceDir, name);
        const meta = readMeta(folder);
        if (meta === null) {
          // a folder without its tree.json is not a tree: fetch it again
          rmSync(folder, { recursive: true, force: true });
          continue;
        }
        const lastRead = statSync(folder).mtimeMs;
        this.index.set(folder, { folder, meta, lastRead });
      }
    }
    return { trees: this.index.size, bytes: this.bytes() };
  }

  trees(): number {
    return this.index.size;
  }

  bytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.meta.bytes;
    return total;
  }

  folder(source: string, commit: string, ignoreKey: string): string {
    return treeFolder(this.dir, source, commit, ignoreKey);
  }

  // a published tree, from the index or, past a concurrent job's
  // rename, from its tree.json
  get(source: string, commit: string, ignoreKey: string): CacheEntry | null {
    const folder = this.folder(source, commit, ignoreKey);
    const known = this.index.get(folder);
    if (known !== undefined) return known;
    const meta = readMeta(folder);
    return meta === null ? null : this.add(folder, meta);
  }

  add(folder: string, meta: TreeMeta): CacheEntry {
    const entry = { folder, meta, lastRead: this.clock() };
    this.index.set(folder, entry);
    return entry;
  }

  // taken at mount, released when the turn ends; null when the folder
  // went from the disk, which forgets it
  hold(entry: CacheEntry): (() => void) | null {
    try {
      statSync(join(entry.folder, "files"));
    } catch {
      this.index.delete(entry.folder);
      return null;
    }
    const now = this.clock();
    entry.lastRead = now;
    if (now - (this.touched.get(entry.folder) ?? 0) >= TOUCH_MS) {
      this.touched.set(entry.folder, now);
      try {
        const seconds = now / 1000;
        utimesSync(entry.folder, seconds, seconds);
      } catch {}
    }
    this.holds.set(entry.folder, (this.holds.get(entry.folder) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(entry.folder) ?? 1) - 1;
      if (left > 0) this.holds.set(entry.folder, left);
      else this.holds.delete(entry.folder);
    };
  }

  held(folder: string): boolean {
    return (this.holds.get(folder) ?? 0) > 0;
  }

  // whether a fetch of up to repoBytes leaves the volume room
  roomFor(repoBytes: number): boolean {
    try {
      return this.free(this.dir) >= repoBytes + REPO_FREE_BYTES;
    } catch {
      return false;
    }
  }

  // the trees read least recently go until the rest fit the cap; each
  // is renamed out of trees/ at once and removed in the background
  evict(capBytes: number): { trees: number; bytes: number } {
    let total = this.bytes();
    let trees = 0;
    let bytes = 0;
    if (total <= capBytes) return { trees, bytes };
    const order = [...this.index.values()].sort(
      (a, b) => a.lastRead - b.lastRead,
    );
    for (const entry of order) {
      if (total <= capBytes) break;
      if (this.held(entry.folder)) continue;
      const away = join(tmpDir(this.dir), `evict-${newId()}`);
      try {
        renameSync(entry.folder, away);
      } catch {
        continue;
      }
      this.index.delete(entry.folder);
      this.touched.delete(entry.folder);
      void rm(away, { recursive: true, force: true }).catch(() => {});
      total -= entry.meta.bytes;
      trees++;
      bytes += entry.meta.bytes;
    }
    return { trees, bytes };
  }

  // hourly: evict past the cap, and clear what a job left in tmp/ past
  // its deadline, never a running job's folder
  sweep(
    capBytes: number,
    running: ReadonlySet<string>,
    staleMs: number,
  ): Swept {
    const evicted = this.evict(capBytes);
    let tmp = 0;
    let names: string[] = [];
    try {
      names = readdirSync(tmpDir(this.dir));
    } catch {}
    const now = this.clock();
    for (const name of names) {
      if (running.has(name)) continue;
      const path = join(tmpDir(this.dir), name);
      try {
        if (now - statSync(path).mtimeMs < staleMs) continue;
      } catch {
        continue;
      }
      void rm(path, { recursive: true, force: true }).catch(() => {});
      tmp++;
    }
    return { ...evicted, tmp };
  }
}
