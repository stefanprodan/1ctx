// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The trees a turn mounts from its project's repositories, and row state.

import type { RepoError } from "../../shared/contracts/repo.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { adapter } from "./adapters.ts";
import type { CacheEntry, RepoCache } from "./cache.ts";
import type { RepoAuth } from "./check.ts";
import {
  type Failure,
  Fetches,
  fail,
  type RepoLimits,
  sourceOf,
} from "./fetches.ts";
import type { JobRunner } from "./jobs.ts";
import { REPO_WAIT_MS } from "./limits.ts";
import { logFetchFailed } from "./log.ts";
import { type Lookup, Lookups, scopedEtag } from "./lookup.ts";
import { ignoreKey } from "./rules.ts";
import type { RepoRow, ReposStore } from "./store.ts";

export type { RepoLimits } from "./fetches.ts";

export type RepoMount = {
  repoId: string;
  name: string;
  url: string;
  ref: string;
  commit: string;
  // the tree's files/ folder, absolute
  folder: string;
  files: number;
  dirs: number;
  bytes: number;
  // files past repoFileBytes, listed and unreadable
  large: number;
  // files the ignore rules kept out
  ignored: number;
  // links out of the tree and members not kept
  dropped: number;
  // a regenerate's commit that is no longer cached, so the lookup's
  // commit is mounted instead
  missedPin: string | null;
};

export type RepoNotice = { repoId: string; name: string; reason: RepoError };

export type Prepared = {
  mounts: RepoMount[];
  notices: RepoNotice[];
  // drops the holds on every folder mounted; once is enough
  release(): void;
};

export type PrepareOptions = {
  // the repositories the session turned off
  off?: ReadonlySet<string>;
  // a regenerate: the commit the original turn mounted, by repository
  pinned?: ReadonlyMap<string, string>;
  waitMs?: number;
  signal?: AbortSignal;
};

export type MountsDeps = {
  store: ReposStore;
  // null when the server runs without a cache directory
  cache: RepoCache | null;
  jobs: JobRunner;
  fetch: typeof fetch;
  auth(repo: RepoRow): RepoAuth;
  limits(): RepoLimits;
  clock: Clock;
  log: Log;
  // a process slot, shared with commands
  acquire(signal: AbortSignal): Promise<() => void>;
  userAgent: string;
};

type Ensured =
  | {
      ok: true;
      entry: CacheEntry;
      release: () => void;
      missedPin: string | null;
    }
  | Failure;

const EMPTY: Prepared = { mounts: [], notices: [], release() {} };

export class Mounts {
  private readonly closing = new AbortController();

  // null without a cache directory
  private readonly fetches: Fetches | null = null;
  private readonly lookups: Lookups | null = null;

  constructor(private readonly deps: MountsDeps) {
    if (deps.cache === null) return;
    const live = { ...deps, cache: deps.cache };
    this.fetches = new Fetches({ ...live, signal: this.closing.signal });
    this.lookups = new Lookups(live, this.fetches);
  }

  // at startup: a fetch the process was running goes back to pending,
  // and every pending row is fetched, so none waits for a turn
  start(): { trees: number; bytes: number } | null {
    this.deps.store.resetFetching();
    const started = this.deps.cache?.start() ?? null;
    if (started !== null) {
      for (const id of this.deps.store.pending()) this.refresh(id);
    }
    return started;
  }

  async prepare(
    projectId: string,
    options: PrepareOptions = {},
  ): Promise<Prepared> {
    const rows = this.deps.store.forProject(projectId);
    if (rows.length === 0) return EMPTY;
    const on = rows.filter((row) => !options.off?.has(row.id));
    if (on.length === 0) return EMPTY;
    if (this.deps.cache === null) {
      return {
        ...EMPTY,
        notices: on.map((row) => ({
          repoId: row.id,
          name: row.name,
          reason: "cache full",
        })),
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const waited = new Promise<"wait">((resolve) => {
      stop = () => resolve("wait");
      timer = setTimeout(stop, options.waitMs ?? REPO_WAIT_MS);
      if (options.signal?.aborted) stop();
      options.signal?.addEventListener("abort", stop, { once: true });
    });
    try {
      const results = await Promise.all(
        on.map(async (row) => {
          const work = this.ensure(row, options.pinned?.get(row.id));
          const out = await Promise.race([work, waited]);
          if (out === "wait") {
            // the fetch goes on; a hold it takes later is not this turn's
            void work.then((late) => late.ok && late.release());
          }
          return { row, out };
        }),
      );
      const mounts: RepoMount[] = [];
      const notices: RepoNotice[] = [];
      const releases: (() => void)[] = [];
      for (const { row, out } of results) {
        if (out === "wait" || !out.ok) {
          const reason = out === "wait" ? "fetching" : out.error;
          notices.push({ repoId: row.id, name: row.name, reason });
          continue;
        }
        releases.push(out.release);
        const meta = out.entry.meta;
        mounts.push({
          repoId: row.id,
          name: row.name,
          url: row.url,
          ref: row.ref,
          commit: meta.commit,
          folder: `${out.entry.folder}/files`,
          files: meta.files,
          dirs: meta.dirs,
          bytes: meta.bytes,
          large: meta.large,
          ignored: meta.ignored,
          dropped: meta.dropped,
          missedPin: out.missedPin,
        });
      }
      return {
        mounts,
        notices,
        release: () => {
          for (const release of releases) release();
        },
      };
    } finally {
      clearTimeout(timer);
      if (stop) options.signal?.removeEventListener("abort", stop);
    }
  }

  // after a create, a refresh or a change to what is fetched: look up
  // afresh and fetch now, so the admin sees the outcome on the row
  refresh(repoId: string): void {
    if (this.deps.cache === null || this.closing.signal.aborted) return;
    const row = this.deps.store.byId(repoId);
    if (row === null) return;
    this.lookups!.forget(row);
    this.fetches!.forget(row);
    void this.ensure(row).then((done) => done.ok && done.release());
  }

  // hourly: the cap kept and what a job left behind cleared
  sweep(): void {
    this.lookups?.prune(this.deps.clock());
    this.fetches?.sweep();
  }

  // the drain: every job ends, and no row is written after
  close(): void {
    this.closing.abort();
  }

  private async ensure(row: RepoRow, pinned?: string): Promise<Ensured> {
    try {
      const cache = this.deps.cache!;
      const looked = await this.lookups!.get(row);
      if (!looked.ok) return this.failed(row, looked);
      const source = sourceOf(row);
      const ignore = ignoreKey(row.ignore);
      let commit = looked.commit;
      let missedPin: string | null = null;
      if (pinned !== undefined && pinned !== commit) {
        if (cache.get(source, pinned, ignore) !== null) commit = pinned;
        else missedPin = pinned;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const entry = cache.get(source, commit, ignore);
        if (entry !== null) {
          const release = cache.hold(entry);
          if (release !== null) {
            if (commit === looked.commit) this.ready(row, entry, looked);
            return { ok: true, entry, release, missedPin };
          }
        }
        this.markFetching(row);
        const tree = await this.fetches!.byCommit(row, commit, looked.header);
        if (!tree.ok) return this.failed(row, tree);
      }
      return this.failed(row, fail("host unreachable"));
    } catch {
      return this.failed(row, fail("host unreachable"));
    }
  }

  private markFetching(row: RepoRow): void {
    if (row.state === "fetching" || this.closing.signal.aborted) return;
    row.state = "fetching";
    this.deps.store.setFetched(row.id, { state: "fetching", error: null }, row);
  }

  private ready(
    row: RepoRow,
    entry: CacheEntry,
    looked: Lookup & { ok: true },
  ) {
    const meta = entry.meta;
    const etag = scopedEtag(row, looked.etag);
    if (
      this.closing.signal.aborted ||
      (row.state === "ready" &&
        row.commit === meta.commit &&
        row.etag === etag &&
        row.files === meta.files &&
        row.bytes === meta.bytes &&
        row.ignored === meta.ignored)
    ) {
      return;
    }
    Object.assign(row, {
      state: "ready",
      error: null,
      commit: meta.commit,
      etag,
    });
    this.deps.store.setFetched(
      row.id,
      {
        state: "ready",
        error: null,
        etag,
        commit: meta.commit,
        fetchedAt: this.deps.clock(),
        files: meta.files,
        bytes: meta.bytes,
        ignored: meta.ignored,
      },
      row,
    );
  }

  // a row's first failure with this word is written and logged
  private failed(row: RepoRow, failure: Failure): Failure {
    // a fetch that only waited too long for a slot: the host was fine
    if (failure.queued) return { ...failure, error: "fetching" };
    if (
      !this.closing.signal.aborted &&
      (row.state !== "failed" || row.error !== failure.error)
    ) {
      row.state = "failed";
      row.error = failure.error;
      // over the size cap, the row says what was counted against the caps
      const written = this.deps.store.setFetched(
        row.id,
        { state: "failed", error: failure.error, ...(failure.seen ?? {}) },
        row,
      );
      // a row changed since: its own fetch says how that went
      if (!written) return failure;
      logFetchFailed(this.deps.log, {
        repoId: row.id,
        host: adapter(row.url, row.kind).host,
        error: failure.error,
        status: failure.status,
      });
    }
    return failure;
  }
}
