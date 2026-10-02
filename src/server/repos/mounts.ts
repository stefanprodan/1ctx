// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// From a project's repositories to the trees a turn mounts: one lookup
// per repository a minute, a fetch per commit and ignore rules at a
// time, a turn's wait for a cold tree capped, and a hold on every folder
// mounted. The row's state follows: pending, fetching, ready or failed.

import type { RepoError } from "../../shared/contracts/repo.ts";
import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { type Adapter, adapter, isCommit } from "./adapters.ts";
import type { CacheEntry, RepoCache } from "./cache.ts";
import type { RepoAuth, RepoHeader } from "./check.ts";
import {
  type Failure,
  type Fetched,
  Fetches,
  fail,
  hash,
  type RepoLimits,
  sourceOf,
  type Tree,
} from "./fetches.ts";
import type { JobRunner } from "./jobs.ts";
import { REPO_LOOKUP_MS, REPO_WAIT_MS } from "./limits.ts";
import { logFetchFailed } from "./log.ts";
import { apiLookup } from "./lookup.ts";
import { ignoreKey } from "./rules.ts";
import type { RepoRow, ReposStore } from "./store.ts";
import type { JobEvent } from "./unpack.ts";

export { type RepoLimits, sourceOf } from "./fetches.ts";

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

type Lookup =
  | { ok: true; commit: string; etag: string | null; header: RepoHeader | null }
  | Failure;
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
  // by URL, ref and key: an admin who names one key in two projects
  // grants both the same access, and a signed and an unsigned lookup
  // never share
  private readonly lookups = new Map<
    string,
    { at: number; answer: Promise<Lookup> }
  >();
  private readonly closing = new AbortController();

  // null without a cache directory
  private readonly fetches: Fetches | null;

  constructor(private readonly deps: MountsDeps) {
    this.fetches =
      deps.cache === null
        ? null
        : new Fetches({
            ...deps,
            cache: deps.cache,
            signal: this.closing.signal,
          });
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
    this.lookups.delete(this.lookupKey(row));
    this.fetches!.forget(row.url);
    void this.ensure(row).then((done) => done.ok && done.release());
  }

  // hourly: the cap kept and what a job left behind cleared
  sweep(): void {
    const now = this.deps.clock();
    for (const [key, entry] of this.lookups) {
      if (now - entry.at >= REPO_LOOKUP_MS) this.lookups.delete(key);
    }
    this.fetches?.sweep();
  }

  // the drain: every job ends, and no row is written after
  close(): void {
    this.closing.abort();
  }

  private lookupKey(row: RepoRow): string {
    return `${row.url}\n${row.ref}\n${row.keyName ?? ""}`;
  }

  // the row's ETag when it was stored for this same lookup
  private storedEtag(row: RepoRow): string | null {
    const scope = `${hash(this.lookupKey(row), 12)} `;
    return row.etag?.startsWith(scope) ? row.etag.slice(scope.length) : null;
  }

  private scoped(row: RepoRow, etag: string | null): string | null {
    return etag === null ? null : `${hash(this.lookupKey(row), 12)} ${etag}`;
  }

  private async ensure(row: RepoRow, pinned?: string): Promise<Ensured> {
    try {
      const cache = this.deps.cache!;
      const looked = await this.lookup(row);
      if (!looked.ok) return this.failed(row, looked);
      const source = sourceOf(row.url);
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
        this.state(row, "fetching");
        const tree = await this.fetches!.byCommit(row, commit, looked.header);
        if (!tree.ok) return this.failed(row, tree);
      }
      return this.failed(row, fail("host unreachable"));
    } catch {
      return this.failed(row, fail("host unreachable"));
    }
  }

  private lookup(row: RepoRow): Promise<Lookup> {
    const key = this.lookupKey(row);
    const now = this.deps.clock();
    // an expired answer may hold a key's header: never kept
    for (const [old, entry] of this.lookups) {
      if (now - entry.at >= REPO_LOOKUP_MS) this.lookups.delete(old);
    }
    const hit = this.lookups.get(key);
    if (hit !== undefined) return hit.answer;
    const answer = this.lookUp(row).catch(() => fail("host unreachable"));
    this.lookups.set(key, { at: now, answer });
    return answer;
  }

  private async lookUp(row: RepoRow): Promise<Lookup> {
    const auth = this.deps.auth(row);
    if (!auth.ok) return fail("no access");
    const header = auth.header;
    // a commit is looked up too: the host's answer is the proof of
    // access, never a tree another project fetched
    const host = adapter(row.url, row.kind);
    if (header === null) return this.archiveLookup(row, host);
    const etag = row.commit === null ? null : this.storedEtag(row);
    const looked = await apiLookup(
      this.deps.fetch,
      host,
      row.ref,
      header,
      etag,
      this.deps.userAgent,
    );
    if (!looked.ok) return looked;
    return {
      ok: true,
      commit: looked.commit ?? row.commit!,
      etag: looked.etag,
      header,
    };
  }

  // public: a GET of the archive by ref is the lookup, its 304 or the
  // commit its first member names, and the tarball when that is new
  private archiveLookup(row: RepoRow, host: Adapter): Promise<Lookup> {
    const cache = this.deps.cache!;
    const source = sourceOf(row.url);
    const ignore = ignoreKey(row.ignore);
    const stored = this.storedEtag(row);
    const etag =
      stored !== null &&
      row.commit !== null &&
      cache.get(source, row.commit, ignore) !== null
        ? stored
        : null;
    return new Promise<Lookup>((resolve) => {
      let settled = false;
      // the job's answer, whenever its event comes
      let answered: (done: Fetched) => void = () => {};
      const finished = new Promise<Fetched>((then) => {
        answered = then;
      });
      const onEvent = (event: JobEvent): boolean => {
        if (settled) return false;
        settled = true;
        const commit = event.commit ?? row.commit!;
        let go = true;
        if (event.commit !== null && !event.published) {
          const folder = cache.folder(source, commit, ignore);
          // a tree refused a while ago or being fetched is not unpacked
          // twice: the job stops at the commit and the turn asks for it
          if (
            this.fetches!.refusal(folder, row) !== null ||
            this.fetches!.busy(folder)
          ) {
            go = false;
          } else {
            // the job unpacks on: it is this commit's fetch now
            const tree = finished.then((done) =>
              done.ok || done.error !== "no commit"
                ? (done as Tree)
                : fail("host unreachable"),
            );
            this.fetches!.track(folder, tree, row);
          }
        }
        resolve({ ok: true, commit, etag: event.etag, header: null });
        return go;
      };
      const job = this.fetches!.run(
        row,
        host,
        {
          url: host.archiveUrl(row.ref),
          etag,
          expect: isCommit(row.ref) ? row.ref : null,
          header: null,
        },
        onEvent,
      );
      void job.then(answered);
      void job.then(async (done) => {
        if (settled) return;
        settled = true;
        if (done.ok) {
          resolve({
            ok: true,
            commit: done.entry.meta.commit,
            etag: null,
            header: null,
          });
        } else if (done.error === "no commit") {
          // an archive without the commit's comment: the API answers it
          const looked = await apiLookup(
            this.deps.fetch,
            host,
            row.ref,
            null,
            null,
            this.deps.userAgent,
          );
          resolve(
            looked.ok
              ? { ok: true, commit: looked.commit!, etag: null, header: null }
              : looked,
          );
        } else {
          resolve(done);
        }
      });
    });
  }

  private state(row: RepoRow, state: "fetching"): void {
    if (row.state === state || this.closing.signal.aborted) return;
    row.state = state;
    this.deps.store.setFetched(row.id, { state, error: null });
  }

  private ready(
    row: RepoRow,
    entry: CacheEntry,
    looked: Lookup & { ok: true },
  ) {
    const meta = entry.meta;
    const etag = this.scoped(row, looked.etag);
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
    this.deps.store.setFetched(row.id, {
      state: "ready",
      error: null,
      etag,
      commit: meta.commit,
      fetchedAt: this.deps.clock(),
      files: meta.files,
      bytes: meta.bytes,
      ignored: meta.ignored,
    });
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
      this.deps.store.setFetched(row.id, {
        state: "failed",
        error: failure.error,
        ...(failure.seen ?? {}),
      });
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
