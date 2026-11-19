// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pull helper's frames, read from its stdout as they arrive. Each
// file's size is checked against the bounds before a byte of it is
// held, so a sandbox can never make the server allocate past them.

import {
  MAX_LINE_BYTES,
  PUSH_CHUNK_BYTES,
  pathOf,
  rootOf,
  unescapePath,
} from "./frames.ts";

export type PullFrame =
  | {
      missing: false;
      path: string;
      escaped: string;
      unicode: boolean;
      mode: number;
      data: Uint8Array;
      sha256: string;
    }
  | { missing: true; path: string; escaped: string; unicode: boolean };

// a file's bytes and the bytes of every file together; a path in
// `paths` holds at most its own bound, smaller than a file's
export type PullBounds = {
  fileBytes: number;
  totalBytes: number;
  paths?: ReadonlyMap<string, number>;
};

export type PullFailure = {
  ok: false;
  reason:
    | "malformed"
    | "order"
    | "outside"
    | "file"
    | "total"
    | "unfinished"
    | "count"
    | "refused";
  // the 0-based frame it stopped at
  frame: number;
};

export type PullResult = { ok: true; frames: PullFrame[] } | PullFailure;

// the pull helper's stdin: escaped paths, as the walk spelled them
export function pullRequest(escaped: readonly string[]): Uint8Array {
  for (const path of escaped)
    if (!unescapePath(path)) throw new TypeError("not an escaped path");
  return new TextEncoder().encode(escaped.map((path) => `${path}\n`).join(""));
}

// The paths in batches whose request is strictly under `limit` bytes,
// one exec each: the gateway refuses an exec request past its 1 MiB
// message, so a long list of long names never rides in one.
export function pullBatches(
  escaped: readonly string[],
  limit = PUSH_CHUNK_BYTES,
): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let used = 0;
  for (const path of escaped) {
    const size = path.length + 1;
    if (size >= limit) throw new RangeError("a pull path past the request");
    if (used + size >= limit) {
      out.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(path);
    used += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

const TRAILER = /^PULL done (0|[1-9][0-9]{0,9})$/;
const REFUSED = /^PULL refused [a-z]{1,16}$/;
const ascii = new TextDecoder("ascii");

type Body = {
  head: { path: string; escaped: string; unicode: boolean; mode: number };
  data: Uint8Array;
  filled: number;
};

export class PullDecoder {
  private readonly frames: PullFrame[] = [];
  private readonly roots: readonly string[];
  private readonly bounds: PullBounds;
  private readonly asked: readonly string[];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private body: Body | null = null;
  private total = 0;
  private done = false;
  private failure: PullFailure | null = null;

  // asked: the escaped paths sent, in order; a frame answers each
  constructor(
    roots: readonly string[],
    bounds: PullBounds,
    asked: readonly string[],
  ) {
    this.roots = roots;
    this.bounds = bounds;
    this.asked = asked;
  }

  push(chunk: Uint8Array): PullFailure | null {
    let at = 0;
    while (!this.failure && at < chunk.byteLength) {
      if (this.done) return this.fail("malformed");
      if (this.body) {
        const body = this.body;
        const take = Math.min(
          body.data.byteLength - body.filled,
          chunk.byteLength - at,
        );
        body.data.set(chunk.subarray(at, at + take), body.filled);
        body.filled += take;
        at += take;
        if (body.filled === body.data.byteLength) this.finish(body);
        continue;
      }
      const newline = chunk.indexOf(0x0a, at);
      const end = newline === -1 ? chunk.byteLength : newline;
      if (this.pendingBytes + end - at > MAX_LINE_BYTES)
        return this.fail("malformed");
      this.pending.push(chunk.subarray(at, end));
      this.pendingBytes += end - at;
      at = end;
      if (newline !== -1) {
        at++;
        const line = ascii.decode(Buffer.concat(this.pending));
        this.pending = [];
        this.pendingBytes = 0;
        this.header(line);
      }
    }
    return this.failure;
  }

  end(): PullResult {
    if (this.failure) return this.failure;
    if (!this.done || this.body || this.pendingBytes > 0)
      return this.fail("unfinished");
    return { ok: true, frames: this.frames };
  }

  private fail(reason: PullFailure["reason"]): PullFailure {
    this.failure ??= { ok: false, reason, frame: this.frames.length };
    return this.failure;
  }

  private header(line: string) {
    const trailer = TRAILER.exec(line);
    if (trailer) {
      this.done = true;
      if (
        Number(trailer[1]) !== this.frames.length ||
        this.frames.length !== this.asked.length
      )
        this.fail("count");
      return;
    }
    if (REFUSED.test(line)) {
      this.fail("refused");
      return;
    }
    let head: unknown;
    try {
      head = JSON.parse(line);
    } catch {
      this.fail("malformed");
      return;
    }
    if (typeof head !== "object" || head === null) {
      this.fail("malformed");
      return;
    }
    const {
      path: escaped,
      missing,
      size,
      mode,
      ...rest
    } = head as Record<string, unknown>;
    if (typeof escaped !== "string" || Object.keys(rest).length > 0) {
      this.fail("malformed");
      return;
    }
    if (escaped !== this.asked[this.frames.length]) {
      this.fail("order");
      return;
    }
    const raw = unescapePath(escaped);
    if (!raw) {
      this.fail("malformed");
      return;
    }
    const { path, unicode } = pathOf(raw);
    const root = rootOf(path, this.roots);
    if (!root || root.top) {
      this.fail("outside");
      return;
    }
    if (missing === true && size === undefined && mode === undefined) {
      this.frames.push({ missing: true, path, escaped, unicode });
      return;
    }
    if (
      missing !== undefined ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      !Number.isInteger(mode) ||
      (mode as number) < 0 ||
      (mode as number) > 0o7777
    ) {
      this.fail("malformed");
      return;
    }
    const bytes = size as number;
    // every bound before the allocation
    if (bytes > (this.bounds.paths?.get(escaped) ?? this.bounds.fileBytes)) {
      this.fail("file");
      return;
    }
    if (this.total + bytes > this.bounds.totalBytes) {
      this.fail("total");
      return;
    }
    this.total += bytes;
    const body: Body = {
      head: { path, escaped, unicode, mode: mode as number },
      data: new Uint8Array(bytes),
      filled: 0,
    };
    if (bytes === 0) this.finish(body);
    else this.body = body;
  }

  private finish(body: Body) {
    this.body = null;
    this.frames.push({
      missing: false,
      ...body.head,
      data: body.data,
      sha256: new Bun.CryptoHasher("sha256").update(body.data).digest("hex"),
    });
  }
}

export function decodePull(
  output: Uint8Array,
  roots: readonly string[],
  bounds: PullBounds,
  asked: readonly string[],
): PullResult {
  const decoder = new PullDecoder(roots, bounds, asked);
  decoder.push(output);
  return decoder.end();
}
