// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A ref's commit now: the API's answer, or the archive's when no key signs.

import type { RepoError } from "../../shared/contracts/repo.ts";
import { readStream } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { sha256 } from "../lib/ids.ts";
import { type Adapter, adapter, isCommit } from "./adapters.ts";
import type { RepoCache } from "./cache.ts";
import type { RepoAuth, RepoHeader } from "./check.ts";
import {
  asTree,
  endpointKind,
  type Failure,
  type Fetched,
  type Fetches,
  fail,
  sourceOf,
} from "./fetches.ts";
import {
  REPO_LOOKUP_BYTES,
  REPO_LOOKUP_DEADLINE_MS,
  REPO_LOOKUP_MS,
} from "./limits.ts";
import { follow, statusError } from "./redirect.ts";
import { ignoreKey } from "./rules.ts";
import type { RepoRow } from "./store.ts";
import type { JobEvent } from "./unpack.ts";

export type Looked =
  | { ok: true; commit: string | null; etag: string | null }
  | { ok: false; error: RepoError; status: number | null };

function commitOf(text: string): string | null {
  const trimmed = text.trim();
  if (isCommit(trimmed)) return trimmed;
  try {
    const body = JSON.parse(trimmed) as { id?: unknown; sha?: unknown };
    const id = body.id ?? body.sha;
    return typeof id === "string" && isCommit(id) ? id : null;
  } catch {
    return null;
  }
}

// commit null on a 304: the ref is where the ETag's answer left it
export async function apiLookup(
  fetcher: typeof fetch,
  adapter: Adapter,
  ref: string,
  header: RepoHeader | null,
  etag: string | null,
  userAgent: string,
): Promise<Looked> {
  const headers: Record<string, string> = {
    ...adapter.lookupHeaders,
    "user-agent": userAgent,
  };
  if (etag !== null) headers["if-none-match"] = etag;
  const signal = AbortSignal.timeout(REPO_LOOKUP_DEADLINE_MS);
  const followed = await follow(
    fetcher,
    adapter.lookupUrl(ref),
    headers,
    header,
    signal,
  );
  if (!followed.ok) return followed;
  const response = followed.response;
  const status = response.status;
  if (status === 304 && etag !== null) {
    response.body?.cancel().catch(() => {});
    return { ok: true, commit: null, etag };
  }
  if (status !== 200) {
    response.body?.cancel().catch(() => {});
    const error = status === 422 ? "not found" : statusError(status);
    return { ok: false, error, status };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readStream(response.body, REPO_LOOKUP_BYTES, signal);
  } catch {
    return { ok: false, error: "host unreachable", status };
  }
  const commit =
    bytes === null ? null : commitOf(new TextDecoder().decode(bytes));
  if (commit === null) return { ok: false, error: "host unreachable", status };
  return { ok: true, commit, etag: response.headers.get("etag") };
}

export type Lookup =
  | { ok: true; commit: string; etag: string | null; header: RepoHeader | null }
  | Failure;

export type LookupsDeps = {
  cache: RepoCache;
  fetch: typeof fetch;
  auth(repo: RepoRow): RepoAuth;
  clock: Clock;
  userAgent: string;
};

// by kind, URL, ref and key: an admin who names one key in two
// projects grants both the same access, a signed and an unsigned
// lookup never share, and neither do two kinds' endpoints
const lookupKey = (row: RepoRow) =>
  `${endpointKind(row)}\n${row.url}\n${row.ref}\n${row.keyName ?? ""}`;

// a stored ETag is prefixed by its lookup's, so another lookup never sends it
const etagScope = (row: RepoRow) => `${sha256(lookupKey(row)).slice(0, 12)} `;

export const scopedEtag = (row: RepoRow, etag: string | null) =>
  etag === null ? null : `${etagScope(row)}${etag}`;

// the row's ETag when it was stored for this same lookup
function storedEtag(row: RepoRow): string | null {
  const scope = etagScope(row);
  return row.etag?.startsWith(scope) ? row.etag.slice(scope.length) : null;
}

// one lookup per repository a minute, shared by the turns that ask
export class Lookups {
  private readonly answers = new Map<
    string,
    { at: number; answer: Promise<Lookup> }
  >();

  constructor(
    private readonly deps: LookupsDeps,
    private readonly fetches: Fetches,
  ) {}

  get(row: RepoRow): Promise<Lookup> {
    const key = lookupKey(row);
    const now = this.deps.clock();
    // an expired answer may hold a key's header: never kept
    this.prune(now);
    const hit = this.answers.get(key);
    if (hit !== undefined) return hit.answer;
    const answer = this.lookUp(row).catch(() => fail("host unreachable"));
    this.answers.set(key, { at: now, answer });
    return answer;
  }

  forget(row: RepoRow): void {
    this.answers.delete(lookupKey(row));
  }

  prune(now: number): void {
    for (const [key, entry] of this.answers) {
      if (now - entry.at >= REPO_LOOKUP_MS) this.answers.delete(key);
    }
  }

  private async lookUp(row: RepoRow): Promise<Lookup> {
    const auth = this.deps.auth(row);
    if (!auth.ok) return fail("no access");
    const header = auth.header;
    // a commit is looked up too: the host's answer is the proof of
    // access, never a tree another project fetched
    const host = adapter(row.url, row.kind);
    if (header === null) return this.archiveLookup(row, host);
    const etag = row.commit === null ? null : storedEtag(row);
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
    const cache = this.deps.cache;
    const fetches = this.fetches;
    const source = sourceOf(row);
    const ignore = ignoreKey(row.ignore);
    const stored = storedEtag(row);
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
          if (fetches.refusal(folder, row) !== null || fetches.busy(folder)) {
            go = false;
          } else {
            // the job unpacks on: it is this commit's fetch now
            fetches.track(folder, finished.then(asTree), row);
          }
        }
        resolve({ ok: true, commit, etag: event.etag, header: null });
        return go;
      };
      const job = fetches.run(
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
}
