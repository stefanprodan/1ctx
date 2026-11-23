// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The walk helper's listing, read strictly as it arrives: the walk
// decides deletes as well as fetches, so anything short of a complete,
// well-formed listing within its bounds is a failure and saves nothing.
// Beside other commands an entry that moved under the walk is no
// failure: one gone is absent, one changing is listed as moved.

import {
  escapePath,
  LineReader,
  pathOf,
  rootOf,
  unescapePath,
} from "./frames.ts";

export type WalkEntry = {
  // d a folder, f a regular file, l a link, o anything else
  type: "d" | "f" | "l" | "o";
  mode: number;
  size: number;
  nlink: number;
  // a regular file's, in lowercase hex
  sha256: string | null;
  path: string;
  // the path as the helper spelled it, what a pull asks for
  escaped: string;
  // false when the name's bytes are not UTF-8; path then holds U+FFFD
  unicode: boolean;
};

// counted as the lines arrive: entries, the bytes of every path and the
// sizes of the regular files
export type WalkBounds = {
  entries: number;
  nameBytes: number;
  fileBytes: number;
};

export type WalkFailure = {
  ok: false;
  reason:
    | "malformed"
    | "duplicate"
    | "linked"
    | "outside"
    | "orphan"
    | "root"
    | "partial"
    | "entries"
    | "names"
    | "bytes"
    | "over"
    | "unfinished"
    | "count";
  // the 1-based line it stopped at
  line: number;
};

// an entry that changed while the walk read it, beside other commands
export type WalkMoved = Pick<WalkEntry, "path" | "escaped" | "unicode">;

export type WalkResult =
  | { ok: true; entries: WalkEntry[]; moved: WalkMoved[] }
  | WalkFailure;

const ENTRY =
  /^([dflo]) ([0-7]{1,5}) (0|[1-9][0-9]{0,15}) ([1-9][0-9]{0,9}) (-|[0-9a-f]{64}) (\S+)$/;
const TRAILER =
  /^WALK (?:done (0|[1-9][0-9]{0,9})|over (?:entries|file|bytes) (0|[1-9][0-9]{0,15}))$/;
const ascii = new TextDecoder("ascii");
const ERROR = /^E ([A-Z0-9]+) (\S+)$/;
// a name gone between the listing and its stat, open or scandir
const GONE = new Set(["ENOENT"]);
// a file that grew, shrank or was swapped while hashed, or a name
// turned into a link or a file under the walk
const MOVED = new Set(["ESTALE", "ELOOP", "ENOTDIR"]);

export class WalkDecoder {
  private readonly lines = new LineReader();
  private readonly entries: WalkEntry[] = [];
  private readonly moved: WalkMoved[] = [];
  private readonly folders = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly roots: readonly string[];
  private readonly bounds: WalkBounds;
  // other commands run in the sandbox, so an entry may move under it
  private readonly beside: boolean;
  private nameBytes = 0;
  private fileBytes = 0;
  private line = 0;
  private done = false;
  private failure: WalkFailure | null = null;

  constructor(roots: readonly string[], bounds: WalkBounds, beside = false) {
    this.roots = roots;
    this.bounds = bounds;
    this.beside = beside;
  }

  // the failure once there is one; later chunks change nothing
  push(chunk: Uint8Array): WalkFailure | null {
    if (this.failure) return this.failure;
    if (!this.lines.push(chunk, (bytes) => this.take(bytes)))
      this.failure ??= this.fail("malformed");
    return this.failure;
  }

  end(): WalkResult {
    if (this.failure) return this.failure;
    if (!this.done || !this.lines.empty) return this.fail("unfinished");
    if (this.roots.some((root) => !this.seen.has(escapePath(root))))
      return this.fail("partial");
    return { ok: true, entries: this.entries, moved: this.moved };
  }

  private fail(reason: WalkFailure["reason"]): WalkFailure {
    return { ok: false, reason, line: this.line };
  }

  private take(bytes: Uint8Array): boolean {
    this.line++;
    if (this.done) {
      this.failure = this.fail("malformed");
      return false;
    }
    const text = ascii.decode(bytes);
    const trailer = TRAILER.exec(text);
    if (trailer) {
      if (trailer[1] === undefined) this.failure = this.fail("over");
      else if (Number(trailer[1]) !== this.entries.length)
        this.failure = this.fail("count");
      this.done = true;
      return this.failure === null;
    }
    const error = ERROR.exec(text);
    const failure = error ? this.error(error[1]!, error[2]!) : this.entry(text);
    if (failure) {
      this.failure = this.fail(failure);
      return false;
    }
    return true;
  }

  // an entry the walk could not read: alone, or for a root or any other
  // error, the listing is partial; beside others, one that moved is no
  // failure, held to the same checks as a listed name
  private error(errno: string, escaped: string): WalkFailure["reason"] | null {
    const gone = GONE.has(errno);
    if (!this.beside || !(gone || MOVED.has(errno))) return "partial";
    const named = this.name(escaped);
    if (typeof named === "string") return named;
    if (named.top) return "partial";
    if (!this.folders.has(escaped.slice(0, escaped.lastIndexOf("/"))))
      return "orphan";
    this.seen.add(escaped);
    if (!gone)
      this.moved.push({ path: named.path, escaped, unicode: named.unicode });
    return null;
  }

  // a listed name's path, held to the bounds, the roots and once only
  private name(escaped: string) {
    const raw = unescapePath(escaped);
    if (!raw) return "malformed";
    if (this.entries.length >= this.bounds.entries) return "entries";
    this.nameBytes += raw.byteLength;
    if (this.nameBytes > this.bounds.nameBytes) return "names";
    const { path, unicode } = pathOf(raw);
    // roots are ASCII, so a name that is not UTF-8 still reads under
    // its root; the escaped spelling, one per byte string, is the key
    const at = rootOf(path, this.roots);
    if (!at) return "outside";
    if (this.seen.has(escaped)) return "duplicate";
    return { path, unicode, top: at.top };
  }

  private entry(text: string): WalkFailure["reason"] | null {
    const match = ENTRY.exec(text);
    if (!match) return "malformed";
    const [, type, mode, size, nlink, sha, escaped] = match;
    const named = this.name(escaped!);
    if (typeof named === "string") return named;
    const { path, unicode } = named;
    const isFile = type === "f";
    if ((sha === "-") === isFile) return "malformed";
    if (Number.parseInt(mode!, 8) > 0o7777) return "malformed";
    if (named.top) {
      if (type !== "d") return "root";
    } else if (!this.folders.has(escaped!.slice(0, escaped!.lastIndexOf("/"))))
      return "orphan";
    if (isFile) {
      if (nlink !== "1") return "linked";
      this.fileBytes += Number(size);
      if (this.fileBytes > this.bounds.fileBytes) return "bytes";
    }
    this.seen.add(escaped!);
    if (type === "d") this.folders.add(escaped!);
    this.entries.push({
      type: type as WalkEntry["type"],
      mode: Number.parseInt(mode!, 8),
      size: Number(size),
      nlink: Number(nlink),
      sha256: isFile ? sha! : null,
      path,
      escaped: escaped!,
      unicode,
    });
    return null;
  }
}

export function decodeWalk(
  output: Uint8Array,
  roots: readonly string[],
  bounds: WalkBounds,
  beside = false,
): WalkResult {
  const decoder = new WalkDecoder(roots, bounds, beside);
  decoder.push(output);
  return decoder.end();
}
