// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Runs in the fetch worker: writes a tarball's members under files/.

import {
  closeSync,
  copyFileSync,
  fchmodSync,
  constants as fs,
  futimesSync,
  mkdirSync,
  openSync,
  symlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join, posix } from "node:path";
import type { RepoError } from "../../shared/contracts/repo.ts";
import type { TarMember } from "../lib/archive.ts";
import { normalizePath, validPath } from "../lib/paths.ts";
import { type IgnoreRules, ignored } from "./rules.ts";
import { onDisk, type TreeMeta } from "./tree.ts";

export type FetchCaps = {
  // the kept tree's bytes and files; a file past fileBytes is kept and
  // counted, the mount refuses to read it
  bytes: number;
  files: number;
  fileBytes: number;
};

export class Refused extends Error {
  constructor(readonly word: RepoError) {
    super(word);
  }
}

// a name the volume cannot hold, beside another (folded by case or
// normalizing) or at all (its length or encoding): dropped, never failed
class Dropped extends Error {}

const clash = (error: unknown) =>
  error instanceof Dropped ||
  ["EEXIST", "ENOTDIR", "ENAMETOOLONG", "EILSEQ"].includes(
    (error as NodeJS.ErrnoException | null)?.code ?? "",
  );

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

export class TreeWriter {
  // what each path is, so no member lands under a link or a file
  private readonly kinds = new Map<string, "dir" | "file" | "link">();
  private readonly named = new Set<string>();
  private readonly written = new Set<string>();
  readonly dirs: string[] = [];
  // past a cap the rest is counted, never written, for the numbers
  over = false;

  constructor(
    private readonly files: string,
    private readonly rules: IgnoreRules,
    private readonly caps: FetchCaps,
    private readonly meta: TreeMeta,
    // the tarball's top folder, and the commit's time every member takes
    private readonly top: string,
    readonly time: number,
  ) {
    mkdirSync(files, { recursive: true, mode: 0o700 });
  }

  async write(
    member: TarMember,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const { files, meta, time } = this;
    const top = this.top;
    const name = member.name.replace(/\/+$/, "");
    if (name === top) return;
    if (!name.startsWith(`${top}/`)) throw new Refused("host unreachable");
    const path = normalizePath(name.slice(top.length + 1));
    if (!validPath(path)) throw new Refused("host unreachable");
    if (member.type === "directory") {
      if (
        this.named.has(path) ||
        (this.kinds.has(path) && this.kinds.get(path) !== "dir")
      ) {
        throw new Refused("host unreachable");
      }
      this.named.add(path);
      if (ignored(this.rules, path, true) || this.over) return;
      try {
        this.folder(path);
      } catch (error) {
        if (!clash(error)) throw error;
        meta.dropped++;
      }
      return;
    }
    if (this.named.has(path)) throw new Refused("host unreachable");
    this.named.add(path);
    if (ignored(this.rules, path, false)) {
      meta.ignored++;
      return;
    }
    if (member.type === "file") {
      if (this.count(member.size)) return;
      let fd: number;
      try {
        this.claim(path);
        fd = openSync(
          join(files, path),
          fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | fs.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (!clash(error)) throw error;
        this.uncount(member.size);
        return;
      }
      this.kinds.set(path, "file");
      try {
        for await (const chunk of body) writeAll(fd, chunk);
        fchmodSync(fd, (member.mode & 0o777) | 0o400);
        futimesSync(fd, time, time);
      } finally {
        closeSync(fd);
      }
      this.wrote(path, member.size);
      return;
    }
    const link =
      member.type === "symlink" ? linkTarget(path, member.linkname) : null;
    if (link !== null) {
      if (this.over) return;
      try {
        this.claim(path);
        symlinkSync(link, join(files, path));
      } catch (error) {
        if (!clash(error)) throw error;
        meta.dropped++;
        return;
      }
      this.kinds.set(path, "link");
      meta.disk += onDisk(0);
      return;
    }
    if (member.type === "link") {
      const target = member.linkname.replace(/\/+$/, "");
      const from = target.startsWith(`${top}/`)
        ? normalizePath(target.slice(top.length + 1))
        : "";
      if (this.written.has(from)) {
        const size = Bun.file(join(files, from)).size;
        if (this.count(size)) return;
        try {
          this.claim(path);
          copyFileSync(join(files, from), join(files, path), fs.COPYFILE_EXCL);
        } catch (error) {
          if (!clash(error)) throw error;
          this.uncount(size);
          return;
        }
        this.kinds.set(path, "file");
        utimesSync(join(files, path), time, time);
        this.wrote(path, size);
        return;
      }
    }
    meta.dropped++;
  }

  // counts a file and answers whether a cap is past, so it is not written
  private count(size: number): boolean {
    const { meta, caps } = this;
    meta.files++;
    meta.bytes += size;
    if (size > caps.fileBytes) meta.large++;
    this.over ||= meta.files > caps.files || meta.bytes > caps.bytes;
    return this.over;
  }

  // a file whose name clashed: counted as dropped instead
  private uncount(size: number): void {
    const { meta } = this;
    meta.files--;
    meta.bytes -= size;
    if (size > this.caps.fileBytes) meta.large--;
    meta.dropped++;
  }

  private wrote(path: string, size: number): void {
    this.written.add(path);
    this.meta.disk += onDisk(size);
  }

  private folder(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const kind = this.kinds.get(prefix);
      if (kind === "dir") continue;
      if (kind !== undefined) throw new Refused("host unreachable");
      try {
        mkdirSync(join(this.files, prefix), { mode: 0o755 });
      } catch (error) {
        // every name this job made is in kinds, so one there already is
        // another spelling the volume folds into it: never merged
        if (clash(error)) throw new Dropped();
        throw error;
      }
      this.kinds.set(prefix, "dir");
      this.dirs.push(prefix);
      this.meta.disk += onDisk(0);
    }
  }

  private claim(path: string): void {
    if (this.kinds.has(path)) throw new Refused("host unreachable");
    const slash = path.lastIndexOf("/");
    if (slash > 0) this.folder(path.slice(0, slash));
  }
}
