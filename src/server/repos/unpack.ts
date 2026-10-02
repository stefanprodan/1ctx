// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One fetch: the tarball's request, its commit read from the first
// member, and the tree unpacked into tmp/<job>/ then published whole by
// a rename to its trees/ folder. It runs in the fetch worker and
// touches no database; it answers counts or a closed word, never a
// host's text, a name from the tarball or a location.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  constants as fs,
  futimesSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import type { RepoError } from "../../shared/contracts/repo.ts";
import { streamTar, type TarMember } from "../lib/archive.ts";
import { normalizePath, validPath } from "../lib/paths.ts";
import { isCommit } from "./adapters.ts";
import type { RepoHeader } from "./check.ts";
import { follow, statusError } from "./redirect.ts";
import { effectiveIgnore, ignored, parseIgnore } from "./rules.ts";
import { onDisk, readMeta, type TreeMeta, tmpDir, treeFolder } from "./tree.ts";

export {
  readMeta,
  type TreeMeta,
  tmpDir,
  treeFolder,
  treesDir,
} from "./tree.ts";

export type FetchCaps = {
  // the kept tree's bytes and files; a file past fileBytes is kept and
  // counted, the mount refuses to read it
  bytes: number;
  files: number;
  fileBytes: number;
};

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

// a member the volume cannot hold beside another, as a case-insensitive
// or normalizing one: dropped, never a failed fetch
class Dropped extends Error {}

const clash = (error: unknown) =>
  error instanceof Dropped ||
  ["EEXIST", "ENOTDIR"].includes(
    (error as NodeJS.ErrnoException | null)?.code ?? "",
  );

class Refused extends Error {
  constructor(readonly word: RepoError) {
    super(word);
  }
}

// the tarball named a commit already published: the read stops there
class Published extends Error {}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

// a symlink's target as written: normalized from its folder, so only
// leading ".." walk up and never through another link; null out of the
// tree
function linkTarget(path: string, target: string): string | null {
  if (target === "" || target.startsWith("/") || target.includes("\\")) {
    return null;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved === ".") {
    return null;
  }
  return posix.relative(posix.dirname(path), resolved) || ".";
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
  // past a cap the rest is counted, never written, for the numbers
  let over = false;
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
    let top = "";
    let time = 0;
    let members = 0;
    // what each path is, so no member lands under a link or a file
    const kinds = new Map<string, "dir" | "file" | "link">();
    const named = new Set<string>();
    const written = new Set<string>();
    const dirs: string[] = [];
    let noCommit = false;

    const folder = (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        const kind = kinds.get(prefix);
        if (kind === "dir") continue;
        if (kind !== undefined) throw new Refused("host unreachable");
        try {
          mkdirSync(join(files, prefix), { mode: 0o755 });
        } catch (error) {
          // every name this job made is in kinds, so one there already is
          // another spelling the volume folds into it: never merged
          if (clash(error)) throw new Dropped();
          throw error;
        }
        kinds.set(prefix, "dir");
        dirs.push(prefix);
        meta.disk += onDisk(0);
      }
    };
    const claim = (path: string) => {
      if (kinds.has(path)) throw new Refused("host unreachable");
      const slash = path.lastIndexOf("/");
      if (slash > 0) folder(path.slice(0, slash));
    };

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
        const target = treeFolder(
          job.cacheDir,
          job.source,
          commit,
          job.ignoreKey,
        );
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
        top = member.name.split("/")[0]!;
        time = member.mtime;
        mkdirSync(files, { recursive: true, mode: 0o700 });
      }
      const name = member.name.replace(/\/+$/, "");
      if (name === top) return;
      if (!name.startsWith(`${top}/`)) throw new Refused("host unreachable");
      const path = normalizePath(name.slice(top.length + 1));
      if (!validPath(path)) throw new Refused("host unreachable");
      if (member.type === "directory") {
        if (named.has(path) || (kinds.has(path) && kinds.get(path) !== "dir")) {
          throw new Refused("host unreachable");
        }
        named.add(path);
        if (ignored(rules, path, true) || over) return;
        try {
          folder(path);
        } catch (error) {
          if (!clash(error)) throw error;
          meta.dropped++;
        }
        return;
      }
      if (named.has(path)) throw new Refused("host unreachable");
      named.add(path);
      if (ignored(rules, path, false)) {
        meta.ignored++;
        return;
      }
      if (member.type === "file") {
        meta.files++;
        meta.bytes += member.size;
        if (member.size > job.caps.fileBytes) meta.large++;
        over ||= meta.files > job.caps.files || meta.bytes > job.caps.bytes;
        if (over) return;
        let fd: number;
        try {
          claim(path);
          fd = openSync(
            join(files, path),
            fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW,
            0o600,
          );
        } catch (error) {
          if (!clash(error)) throw error;
          meta.files--;
          meta.bytes -= member.size;
          if (member.size > job.caps.fileBytes) meta.large--;
          meta.dropped++;
          return;
        }
        kinds.set(path, "file");
        try {
          for await (const chunk of body) writeAll(fd, chunk);
          fchmodSync(fd, (member.mode & 0o777) | 0o400);
          futimesSync(fd, time, time);
        } finally {
          closeSync(fd);
        }
        written.add(path);
        meta.disk += onDisk(member.size);
        return;
      }
      const link =
        member.type === "symlink" ? linkTarget(path, member.linkname) : null;
      if (link !== null) {
        if (over) return;
        try {
          claim(path);
          symlinkSync(link, join(files, path));
        } catch (error) {
          if (!clash(error)) throw error;
          meta.dropped++;
          return;
        }
        kinds.set(path, "link");
        meta.disk += onDisk(0);
        return;
      }
      if (member.type === "link") {
        const target = member.linkname.replace(/\/+$/, "");
        const from = target.startsWith(`${top}/`)
          ? normalizePath(target.slice(top.length + 1))
          : "";
        if (written.has(from)) {
          const size = Bun.file(join(files, from)).size;
          meta.files++;
          meta.bytes += size;
          if (size > job.caps.fileBytes) meta.large++;
          over ||= meta.files > job.caps.files || meta.bytes > job.caps.bytes;
          if (over) return;
          try {
            claim(path);
            copyFileSync(
              join(files, from),
              join(files, path),
              fs.COPYFILE_EXCL,
            );
          } catch (error) {
            if (!clash(error)) throw error;
            meta.files--;
            meta.bytes -= size;
            if (size > job.caps.fileBytes) meta.large--;
            meta.dropped++;
            return;
          }
          kinds.set(path, "file");
          utimesSync(join(files, path), time, time);
          written.add(path);
          meta.disk += onDisk(size);
          return;
        }
      }
      meta.dropped++;
    };

    try {
      await streamTar(counted, signal, visit);
    } catch (error) {
      if (!(error instanceof Published)) throw error;
      if (noCommit) return { ok: false, error: "no commit", status };
      const target = treeFolder(
        job.cacheDir,
        job.source,
        commit!,
        job.ignoreKey,
      );
      const held = readMeta(target);
      if (held === null) throw new Refused("host unreachable");
      return {
        ok: true,
        kind: "tree",
        commit: commit!,
        etag,
        meta: held,
        fetched: false,
      };
    }
    if (commit === null)
      return { ok: false, error: "host unreachable", status };
    if (over) throw new Refused("over the size cap");
    inTime();
    Object.assign(meta, { commit, time, dirs: dirs.length });
    // deepest first, since writing a folder's children moved its time
    for (const dir of dirs.reverse()) utimesSync(join(files, dir), time, time);
    utimesSync(files, time, time);
    writeFileSync(join(work, "tree.json"), `${JSON.stringify(meta)}\n`);
    const target = treeFolder(job.cacheDir, job.source, commit, job.ignoreKey);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try {
      renameSync(work, target);
      published = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // a concurrent job published this commit first
      const held = readMeta(target);
      if (held === null) throw new Refused("host unreachable");
      return {
        ok: true,
        kind: "tree",
        commit,
        etag,
        meta: held,
        fetched: false,
      };
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
