// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_FREE_BYTES, RepoCache } from "../../../src/server/repos/cache.ts";
import type { TreeMeta } from "../../../src/server/repos/unpack.ts";
import { COMMIT, cacheDir, NEXT_COMMIT } from "../../helpers/repos.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const meta = (commit: string, bytes: number): TreeMeta => ({
  commit,
  time: 1,
  files: 1,
  dirs: 0,
  bytes,
  large: 0,
  ignored: 0,
  dropped: 0,
});

function setup(free = Number.MAX_SAFE_INTEGER) {
  const dir = cacheDir();
  dirs.push(dir);
  let now = Date.now();
  const clock = () => now;
  const cache = new RepoCache(dir, clock, () => free);
  cache.start();
  // a tree published as a job publishes it
  const publish = (source: string, commit: string, bytes: number) => {
    const folder = cache.folder(source, commit, "k");
    mkdirSync(join(folder, "files"), { recursive: true });
    writeFileSync(
      join(folder, "tree.json"),
      JSON.stringify(meta(commit, bytes)),
    );
    return cache.get(source, commit, "k")!;
  };
  return {
    dir,
    cache,
    publish,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("startup clears tmp/, indexes every tree and drops a folder with no tree.json", () => {
  const { dir, publish } = setup();
  publish("s1", COMMIT, 100);
  publish("s2", COMMIT, 50);
  mkdirSync(join(dir, "trees", "s3", `${COMMIT}-k`, "files"), {
    recursive: true,
  });
  mkdirSync(join(dir, "tmp", "job", "files"), { recursive: true });
  const again = new RepoCache(dir, () => Date.now());
  expect(again.start()).toEqual({ trees: 2, bytes: 150 });
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  expect(existsSync(join(dir, "trees", "s3", `${COMMIT}-k`))).toBe(false);
  expect(again.get("s1", COMMIT, "k")?.meta.bytes).toBe(100);
});

test("eviction takes the least recently read and never a held folder", () => {
  const { cache, publish, tick } = setup();
  const old = publish("s1", COMMIT, 100);
  tick(1_000);
  const held = publish("s1", NEXT_COMMIT, 100);
  tick(1_000);
  const fresh = publish("s2", COMMIT, 100);
  tick(1_000);
  const release = cache.hold(old)!;
  expect(cache.evict(150)).toEqual({ trees: 2, bytes: 200 });
  expect(cache.get("s1", COMMIT, "k")).not.toBeNull();
  expect(existsSync(held.folder)).toBe(false);
  expect(existsSync(fresh.folder)).toBe(false);
  // a hold released lets the folder go
  release();
  release();
  expect(cache.evict(0)).toEqual({ trees: 1, bytes: 100 });
  expect(cache.bytes()).toBe(0);
});

test("a hold on a folder gone from the disk forgets it", () => {
  const { cache, publish } = setup();
  const entry = publish("s1", COMMIT, 100);
  rmSync(entry.folder, { recursive: true });
  expect(cache.hold(entry)).toBeNull();
  expect(cache.get("s1", COMMIT, "k")).toBeNull();
});

test("a fetch needs repoBytes and a GiB free on the volume", () => {
  const { cache } = setup(REPO_FREE_BYTES + 1_000);
  expect(cache.roomFor(1_000)).toBe(true);
  expect(cache.roomFor(1_001)).toBe(false);
  const elsewhere = cacheDir();
  dirs.push(elsewhere);
  const failing = new RepoCache(
    elsewhere,
    () => 0,
    () => {
      throw new Error("statfs failed");
    },
  );
  expect(failing.roomFor(1)).toBe(false);
});

test("the sweep clears a stale job folder, never a running one", () => {
  const { dir, cache, tick } = setup();
  for (const name of ["stale", "running", "young"]) {
    mkdirSync(join(dir, "tmp", name));
  }
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(join(dir, "tmp", "stale"), old, old);
  utimesSync(join(dir, "tmp", "running"), old, old);
  tick(0);
  const swept = cache.sweep(1_000, new Set(["running"]), 5 * 60_000);
  expect(swept).toEqual({ trees: 0, bytes: 0, tmp: 1 });
});
