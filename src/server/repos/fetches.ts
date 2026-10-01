// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fetch queue: one job per tree folder at a time, each in a fetch
// slot and a process slot, the cache made room for before it writes,
// and a tree that failed not fetched again for a while.

import type { RepoError } from "../../shared/contracts/repo.ts";
import type { Clock } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import { Queue } from "../lib/queue.ts";
import type { Limits } from "../limits/index.ts";
import { type Adapter, adapter } from "./adapters.ts";
import type { CacheEntry, RepoCache } from "./cache.ts";
import type { RepoHeader } from "./check.ts";
import type { JobRunner } from "./jobs.ts";
import {
  REPO_FETCH_MS,
  REPO_FETCHES_IN_FLIGHT,
  REPO_LOOKUP_MS,
  REPO_REFUSED_MS,
  REPO_STALL_MS,
} from "./limits.ts";
import { logCacheSwept, logFetched } from "./log.ts";
import { ignoreKey } from "./rules.ts";
import type { RepoRow } from "./store.ts";
import type { JobEvent } from "./unpack.ts";

export type RepoLimits = Pick<
  Limits,
  "repoBytes" | "repoFiles" | "repoFileBytes" | "repoCacheBytes"
>;

export type Failure = {
  ok: false;
  error: RepoError;
  status: number | null;
  // over the size cap: what was counted, for the admin page
  seen?: { files: number; bytes: number };
};
export type Tree = { ok: true; entry: CacheEntry } | Failure;
export type Fetched =
  | Tree
  | { ok: false; error: "no commit"; status: number | null };

export const fail = (error: RepoError): Failure => ({
  ok: false,
  error,
  status: null,
});

export const hash = (text: string, length: number) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, length);

// the cache's folder name for a repository: no disk path part comes
// from a host, a repository or a tarball
export const sourceOf = (url: string) => hash(url, 16);

export type FetchesDeps = {
  cache: RepoCache;
  jobs: JobRunner;
  limits(): RepoLimits;
  clock: Clock;
  log: Log;
  acquire(signal: AbortSignal): Promise<() => void>;
  userAgent: string;
  // the drain's: every job ends
  signal: AbortSignal;
};

export type FetchRequest = {
  url: string;
  etag: string | null;
  expect: string | null;
  header: RepoHeader | null;
};

export class Fetches {
  // a tree being fetched, by its folder
  private readonly inFlight = new Map<string, Promise<Tree>>();
  // a fetch that failed, by its folder and caps, not tried again a while
  private readonly refused = new Map<
    string,
    { until: number; tree: Failure }
  >();
  private readonly running = new Set<string>();
  private readonly slots = new Queue(REPO_FETCHES_IN_FLIGHT);

  constructor(private readonly deps: FetchesDeps) {}

  // a refresh tries a refused tree again at once
  forget(url: string): void {
    const source = sourceOf(url);
    for (const key of this.refused.keys()) {
      if (key.includes(`/${source}/`)) this.refused.delete(key);
    }
  }

  sweep(): void {
    const now = this.deps.clock();
    for (const [key, entry] of this.refused) {
      if (now >= entry.until) this.refused.delete(key);
    }
    const swept = this.deps.cache.sweep(
      this.deps.limits().repoCacheBytes,
      this.running,
      REPO_FETCH_MS,
    );
    if (swept.trees > 0) this.logSwept(swept);
  }

  // a tree being fetched now
  busy(folder: string): boolean {
    return this.inFlight.has(folder);
  }

  // a tree whose fetch failed a while ago, under the caps in force
  refusal(folder: string): Failure | null {
    const key = this.refusedKey(folder);
    const refused = this.refused.get(key);
    if (refused === undefined) return null;
    if (this.deps.clock() < refused.until) return refused.tree;
    this.refused.delete(key);
    return null;
  }

  private refusedKey(folder: string): string {
    const limits = this.deps.limits();
    return `${folder}:${limits.repoBytes}:${limits.repoFiles}`;
  }

  // a tree by commit: joined when in flight, else fetched
  byCommit(row: RepoRow, commit: string, header: RepoHeader | null) {
    const ignore = ignoreKey(row.ignore);
    const folder = this.deps.cache.folder(sourceOf(row.url), commit, ignore);
    const running = this.inFlight.get(folder);
    if (running !== undefined) return running;
    const refused = this.refusal(folder);
    if (refused !== null) return Promise.resolve(refused);
    const host = adapter(row.url, row.kind);
    const url =
      header === null ? host.archiveUrl(commit) : host.tarballUrl(commit);
    const tree = this.run(
      row,
      host,
      { url, etag: null, expect: commit, header },
      () => true,
    ).then((done) => {
      if (done.ok || done.error !== "no commit") return done as Tree;
      return fail("host unreachable");
    });
    return this.track(folder, tree);
  }

  // a tree's fetch, joined by the turns that need it; a failure is
  // not tried again for a while, one over the caps for longer
  track(folder: string, tree: Promise<Tree>): Promise<Tree> {
    this.inFlight.set(folder, tree);
    const key = this.refusedKey(folder);
    void tree.then((done) => {
      if (this.inFlight.get(folder) === tree) this.inFlight.delete(folder);
      if (done.ok || this.deps.signal.aborted) return;
      const hold =
        done.error === "over the size cap" ? REPO_REFUSED_MS : REPO_LOOKUP_MS;
      this.refused.set(key, { until: this.deps.clock() + hold, tree: done });
    });
    return tree;
  }

  async run(
    row: RepoRow,
    host: Adapter,
    request: FetchRequest,
    // false stops the job at the commit, before it unpacks
    onEvent: (event: JobEvent) => boolean,
  ): Promise<Fetched> {
    const cache = this.deps.cache;
    const signal = this.deps.signal;
    let releaseSlot: (() => void) | undefined;
    let releaseProcess: (() => void) | undefined;
    let full = false;
    const id = newId();
    const limits = this.deps.limits();
    // the request, a 304 and a cached commit take no slot; only an
    // unpack does, so a lookup never waits behind other fetches
    const unpack = async (event: JobEvent): Promise<boolean> => {
      if (!onEvent(event)) return false;
      if (event.commit === null || event.published) return true;
      try {
        releaseSlot = await this.slots.acquire(signal);
        releaseProcess = await this.deps.acquire(signal);
      } catch {
        return false;
      }
      if (!cache.roomFor(limits.repoBytes)) {
        full = true;
        return false;
      }
      const evicted = cache.evict(limits.repoCacheBytes);
      if (evicted.trees > 0) this.logSwept(evicted);
      return true;
    };
    try {
      this.running.add(id);
      const started = performance.now();
      const ignore = ignoreKey(row.ignore);
      const source = sourceOf(row.url);
      const done = await this.deps.jobs(
        {
          id,
          url: request.url,
          etag: request.etag,
          header: request.header,
          expect: request.expect,
          ignore: row.ignore,
          ignoreKey: ignore,
          source,
          cacheDir: cache.dir,
          caps: {
            bytes: limits.repoBytes,
            files: limits.repoFiles,
            fileBytes: limits.repoFileBytes,
          },
          deadlineMs: REPO_FETCH_MS,
          stallMs: REPO_STALL_MS,
          userAgent: this.deps.userAgent,
        },
        unpack,
        signal,
      );
      if (full) return fail("cache full");
      if (!done.ok) return done;
      if (done.kind === "unchanged") {
        const entry = cache.get(source, row.commit ?? "", ignore);
        return entry === null ? fail("host unreachable") : { ok: true, entry };
      }
      const folder = cache.folder(source, done.commit, ignore);
      const entry =
        cache.get(source, done.commit, ignore) ?? cache.add(folder, done.meta);
      if (done.fetched) {
        logFetched(this.deps.log, {
          repoId: row.id,
          host: host.host,
          commit: done.commit,
          files: done.meta.files,
          bytes: done.meta.bytes,
          duration: performance.now() - started,
        });
      }
      return { ok: true, entry };
    } catch {
      return fail("host unreachable");
    } finally {
      this.running.delete(id);
      releaseProcess?.();
      releaseSlot?.();
    }
  }

  private logSwept(swept: { trees: number; bytes: number }): void {
    const cache = this.deps.cache;
    logCacheSwept(this.deps.log, {
      trees: swept.trees,
      bytes: swept.bytes,
      kept: cache.trees(),
      keptBytes: cache.bytes(),
    });
  }
}
