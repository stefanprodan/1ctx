// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs in the fetch worker: no database, and never a host's text in a result.

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RepoError } from "../../shared/contracts/repo.ts";
import { streamTar, type TarMember } from "../lib/archive.ts";
import { isCommit } from "./adapters.ts";
import type { RepoHeader } from "./check.ts";
import { follow, statusError } from "./redirect.ts";
import { effectiveIgnore, parseIgnore } from "./rules.ts";
import { readMeta, type TreeMeta, tmpDir, treeFolder } from "./tree.ts";
import { type FetchCaps, Refused, TreeWriter } from "./writer.ts";

export type FetchJob = {
  // tmp/<id>/ while it unpacks
  id: string;
  url: string;
  // sent as If-None-Match; a 304 answers unchanged
  etag: string | null;
  header: RepoHeader | null;
  // the commit the URL names, when it names one
  expect: string | null;
  // the row's ignore text, and the key of its effective rules
  ignore: string;
  ignoreKey: string;
  // the short hash of the repository's URL
  source: string;
  cacheDir: string;
  caps: FetchCaps;
  deadlineMs: number;
  stallMs: number;
  userAgent: string;
};

// sent before the answer: the commit the tarball names, or null for a
// 304, and whether its tree is published already
export type JobEvent = {
  commit: string | null;
  etag: string | null;
  published: boolean;
};

export type JobResult =
  | { ok: true; kind: "unchanged" }
  | {
      ok: true;
      kind: "tree";
      commit: string;
      etag: string | null;
      meta: TreeMeta;
      // false when the folder was there already, or a concurrent job won
      fetched: boolean;
    }
  // the archive named no commit: the caller looks the ref up instead
  | { ok: false; error: "no commit"; status: number | null }
  | {
      ok: false;
      error: RepoError;
      status: number | null;
      // over the size cap: the files and bytes counted when it stopped,
      // the whole tree's when the bounds on what is dropped allowed
      seen?: { files: number; bytes: number };
    };

export type JobIo = {
  fetch: typeof fetch;
  // for a tree not published, whether to unpack it: the caller takes its
  // slots first, or stops a tree it refused
  emit(event: JobEvent): boolean | Promise<boolean>;
  signal?: AbortSignal;
};

// the tarball named a commit already published: the read stops there
class Published extends Error {}

// a tree published already, by an earlier job or a concurrent one
function heldTree(
  target: string,
  commit: string,
  etag: string | null,
): JobResult {
  const held = readMeta(target);
  if (held === null) throw new Refused("host unreachable");
  return { ok: true, kind: "tree", commit, etag, meta: held, fetched: false };
}

export async function runJob(job: FetchJob, io: JobIo): Promise<JobResult> {
  // the deadline starts again at the go: a wait for slots is not the host's
  let started = performance.now();
  const deadline = new AbortController();
  const stall = new AbortController();
  const signal = AbortSignal.any([
    deadline.signal,
    stall.signal,
    ...(io.signal ? [io.signal] : []),
  ]);
  let ends = setTimeout(() => deadline.abort(), job.deadlineMs);
  let stallTimer = setTimeout(() => stall.abort(), job.stallMs);
  // while the caller takes its slots, a quiet stream is no stall
  let paused = false;
  const work = join(tmpDir(job.cacheDir), job.id);
  const files = join(work, "files");
  let published = false;
  // the host's answer, once there is one
  let status: number | null = null;
  const meta: TreeMeta = {
    commit: "",
    time: 0,
    files: 0,
    dirs: 0,
    bytes: 0,
    disk: 0,
    large: 0,
    ignored: 0,
    dropped: 0,
  };
  // past the deadline between members: a slow match never runs on
  const inTime = () => {
    if (performance.now() - started > job.deadlineMs || signal.aborted) {
      throw new Refused("host unreachable");
    }
  };
  try {
    const headers: Record<string, string> = { "user-agent": job.userAgent };
    if (job.etag !== null) headers["if-none-match"] = job.etag;
    const followed = await follow(
      io.fetch,
      job.url,
      headers,
      job.header,
      signal,
    );
    if (!followed.ok) return followed;
    const response = followed.response;
    status = response.status;
    if (status === 304 && job.etag !== null) {
      await response.body?.cancel().catch(() => {});
      io.emit({ commit: null, etag: job.etag, published: true });
      return { ok: true, kind: "unchanged" };
    }
    if (status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: status === 200 ? "host unreachable" : statusError(status),
        status,
      };
    }
    const etag = response.headers.get("etag");
    const parsed = parseIgnore(effectiveIgnore(job.ignore));
    if (!parsed.ok) return { ok: false, error: "host unreachable", status };
    const rules = parsed.rules;
    const compressedCap = 4 * job.caps.bytes;
    let compressed = 0;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          compressed += chunk.length;
          if (compressed > compressedCap) {
            throw new Refused("over the size cap");
          }
          clearTimeout(stallTimer);
          if (!paused) {
            stallTimer = setTimeout(() => stall.abort(), job.stallMs);
          }
          controller.enqueue(chunk);
        },
      }),
    );

    let commit: string | null = null;
    let target = "";
    let members = 0;
    let writer: TreeWriter | null = null;
    let noCommit = false;

    const visit = async (
      member: TarMember,
      body: ReadableStream<Uint8Array>,
    ): Promise<void> => {
      inTime();
      members++;
      if (members > 4 * job.caps.files) throw new Refused("over the size cap");
      if (commit === null) {
        const comment = member.pax.comment;
        if (comment === undefined) {
          if (job.expect === null) {
            noCommit = true;
            throw new Published();
          }
          commit = job.expect;
        } else {
          if (!isCommit(comment)) throw new Refused("host unreachable");
          if (job.expect !== null && comment !== job.expect) {
            throw new Refused("not found");
          }
          commit = comment;
        }
        target = treeFolder(job.cacheDir, job.source, commit, job.ignoreKey);
        const published = existsSync(join(target, "tree.json"));
        paused = true;
        clearTimeout(stallTimer);
        clearTimeout(ends);
        const go = await io.emit({ commit, etag, published });
        paused = false;
        started = performance.now();
        ends = setTimeout(() => deadline.abort(), job.deadlineMs);
        stallTimer = setTimeout(() => stall.abort(), job.stallMs);
        if (published) throw new Published();
        if (!go) throw new Refused("host unreachable");
        inTime();
        writer = new TreeWriter(
          files,
          rules,
          job.caps,
          meta,
          member.name.split("/")[0]!,
          member.mtime,
        );
      }
      await writer!.write(member, body);
    };

    try {
      await streamTar(counted, signal, visit);
    } catch (error) {
      if (!(error instanceof Published)) throw error;
      if (noCommit) return { ok: false, error: "no commit", status };
      return heldTree(target, commit!, etag);
    }
    // narrowed by hand: TypeScript cannot see the callback's writes
    const done = writer as TreeWriter | null;
    if (commit === null || done === null) {
      return { ok: false, error: "host unreachable", status };
    }
    if (done.over) throw new Refused("over the size cap");
    inTime();
    const { time, dirs } = done;
    Object.assign(meta, { commit, time, dirs: dirs.length });
    // deepest first, since writing a folder's children moved its time
    for (const dir of dirs.reverse()) utimesSync(join(files, dir), time, time);
    utimesSync(files, time, time);
    writeFileSync(join(work, "tree.json"), `${JSON.stringify(meta)}\n`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try {
      renameSync(work, target);
      published = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // a concurrent job published this commit first
      return heldTree(target, commit, etag);
    }
    return { ok: true, kind: "tree", commit, etag, meta, fetched: true };
  } catch (error) {
    if (error instanceof Refused) {
      const seen = { files: meta.files, bytes: meta.bytes };
      return error.word === "over the size cap"
        ? { ok: false, error: error.word, status, seen }
        : { ok: false, error: error.word, status };
    }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") {
      return { ok: false, error: "cache full", status };
    }
    return { ok: false, error: "host unreachable", status };
  } finally {
    clearTimeout(ends);
    clearTimeout(stallTimer);
    if (!published) rmSync(work, { recursive: true, force: true });
  }
}
