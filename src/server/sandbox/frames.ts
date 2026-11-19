// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wire between the server and the fixed helpers in a sandbox: the
// push frames, the walk's lines and the pull frames. Pure, so every
// refusal is tested on fixtures. A path crosses percent-escaped: every
// byte outside 0x21 to 0x7e, and %, as %XX in capitals, so a name never
// breaks a line or a field and every name has one spelling.

// the trees a sandbox holds as rows; /repos is mounted, never synced,
// and /tmp is the sandbox's own, never pushed, walked or pulled
export const SANDBOX_ROOTS = ["/knowledge", "/uploads", "/mcp"];

// the gateway refuses an exec request past its 1 MiB message, and the
// helper's own source rides in the same request
export const PUSH_CHUNK_BYTES = 1000 * 1024;

// a line of the walk or a pull header: a path at Linux's PATH_MAX, each
// byte escaped, with room for the fields
export const MAX_LINE_BYTES = 3 * 4096 + 256;

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

export function escapePath(path: string | Uint8Array): string {
  const bytes = typeof path === "string" ? encoder.encode(path) : path;
  let out = "";
  for (const byte of bytes) {
    out +=
      byte >= 0x21 && byte <= 0x7e && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// the bytes of an escaped path, or null when it is not the one spelling
// escapePath gives
export function unescapePath(escaped: string): Uint8Array | null {
  if (
    escaped === "" ||
    !/^(?:[\x21-\x24\x26-\x7e]|%[0-9A-F]{2})+$/.test(escaped)
  )
    return null;
  const out: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === "%") {
      out.push(Number.parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(escaped.charCodeAt(i));
  }
  const bytes = Uint8Array.from(out);
  return escapePath(bytes) === escaped ? bytes : null;
}

// the escaped path's text and whether its bytes were UTF-8; a name
// that is not reads with U+FFFD and fails the name rules later
export function pathOf(bytes: Uint8Array): { path: string; unicode: boolean } {
  try {
    return { path: strict.decode(bytes), unicode: true };
  } catch {
    return { path: lossy.decode(bytes), unicode: false };
  }
}

// the root a path is or is under, and whether it is the root itself
export function rootOf(path: string, roots: readonly string[]) {
  for (const root of roots) {
    if (path === root) return { root, top: true };
    if (path.startsWith(`${root}/`)) {
      const parts = path.slice(root.length + 1).split("/");
      if (parts.some((part) => part === "" || part === "." || part === ".."))
        return null;
      return { root, top: false };
    }
  }
  return null;
}

// ---- push ----

export type PushFolder = { path: string; mode: number; mtime: number };
export type PushFile = PushFolder & { data: Uint8Array };

// mtime is milliseconds since the epoch, mode the permission bits
export type PushManifest = {
  // files, links or empty folders to remove
  remove?: readonly string[];
  // folders to make if missing, taking this mode and time
  folders?: readonly PushFolder[];
  files?: readonly PushFile[];
  // a mode and time for a file or folder already there
  meta?: readonly PushFolder[];
};

const depth = (path: string) => path.split("/").length;

function header(fields: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(fields)}\n`);
}

// milliseconds whose nanoseconds fit utime's 64 bits, as push.py checks
export const MAX_PUSH_MTIME = 9 * 10 ** 12;

function checkFields(entry: PushFolder) {
  if (
    !Number.isInteger(entry.mode) ||
    entry.mode < 0 ||
    entry.mode > 0o7777 ||
    !Number.isSafeInteger(entry.mtime) ||
    entry.mtime < 0 ||
    entry.mtime > MAX_PUSH_MTIME
  )
    throw new TypeError("a push entry needs a mode and a time");
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

// Every path under a root and never a root itself: a root is the
// image's or a mount's, so the helper refuses it.
// Every folder a frame changes, holding a removed or new entry, must
// have its mode in folders or meta: the helper opens it to its owner to
// make the change, and the trailing meta puts the stored mode back.
function checkManifest(manifest: PushManifest, roots: readonly string[]) {
  const all = [
    ...(manifest.remove ?? []),
    ...[
      ...(manifest.folders ?? []),
      ...(manifest.files ?? []),
      ...(manifest.meta ?? []),
    ].map((entry) => entry.path),
  ];
  for (const path of all) {
    const at = rootOf(path, roots);
    if (!at || at.top)
      throw new TypeError("a push path is under a root and not a root");
  }
  for (const entry of [
    ...(manifest.folders ?? []),
    ...(manifest.files ?? []),
    ...(manifest.meta ?? []),
  ])
    checkFields(entry);
  const removed = new Set(manifest.remove ?? []);
  const settled = new Set(
    [...(manifest.folders ?? []), ...(manifest.meta ?? [])].map(
      (entry) => entry.path,
    ),
  );
  const changed = [
    ...(manifest.remove ?? []),
    ...[...(manifest.folders ?? []), ...(manifest.files ?? [])].map(
      (entry) => entry.path,
    ),
  ];
  for (const path of changed) {
    const parent = parentOf(path);
    if (roots.includes(parent) || removed.has(parent)) continue;
    if (!settled.has(parent))
      throw new TypeError("a changed folder needs its mode");
  }
}

// The manifest as the stdin of one exec per chunk, each strictly under
// `limit` bytes, run in order. It throws on a manifest checkManifest
// refuses, a fault in the caller, before the first chunk. Removes go
// deepest first, then folders shallowest first with the owner's rwx so
// the files can land, then the files, then every folder's and meta
// entry's exact mode and time, deepest first: a write would move a
// folder's time, and a folder without the owner's x would close the way
// to the ones below it. A file larger than a chunk goes as a first part
// and appended parts, writable until its last part sets its mode. Each
// chunk is made only when the one before it was taken, so a push holds
// one chunk beside the rows it frames.
export function pushChunks(
  manifest: PushManifest,
  options: { roots?: readonly string[]; limit?: number } = {},
): Generator<Uint8Array, void, undefined> {
  checkManifest(manifest, options.roots ?? SANDBOX_ROOTS);
  return chunksOf(manifest, options.limit ?? PUSH_CHUNK_BYTES);
}

// every chunk at once, for a test that reads them all
export const encodePush = (
  manifest: PushManifest,
  options: { roots?: readonly string[]; limit?: number } = {},
): Uint8Array[] => [...pushChunks(manifest, options)];

function* chunksOf(
  manifest: PushManifest,
  limit: number,
): Generator<Uint8Array, void, undefined> {
  let parts: Uint8Array[] = [];
  let used = 0;
  const take = (): Uint8Array => {
    const chunk = new Uint8Array(used);
    let at = 0;
    for (const part of parts) {
      chunk.set(part, at);
      at += part.byteLength;
    }
    parts = [];
    used = 0;
    return chunk;
  };
  // the chunk made full by the pieces, if any; the pieces are kept
  const add = (...pieces: Uint8Array[]): Uint8Array | null => {
    const size = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
    const full = used > 0 && used + size >= limit ? take() : null;
    if (size >= limit) throw new RangeError("a push frame past the chunk");
    parts.push(...pieces);
    used += size;
    return full;
  };
  const remove = [...(manifest.remove ?? [])].sort(
    (a, b) => depth(b) - depth(a),
  );
  for (const path of remove) {
    const full = add(header({ op: "rm", path: escapePath(path) }));
    if (full) yield full;
  }
  const folders = [...(manifest.folders ?? [])].sort(
    (a, b) => depth(a.path) - depth(b.path),
  );
  for (const folder of folders) {
    const full = add(
      header({
        op: "dir",
        path: escapePath(folder.path),
        mode: folder.mode | 0o700,
        mtime: folder.mtime,
      }),
    );
    if (full) yield full;
  }
  for (const file of manifest.files ?? []) {
    const path = escapePath(file.path);
    const total = file.data.byteLength;
    let sent = 0;
    // a header with the widest fields is never shorter than the one
    // written, so a part sized by it always fits
    const widest = header({
      op: "file",
      path,
      mode: 0o7777,
      mtime: file.mtime,
      size: limit,
      append: true,
    }).byteLength;
    do {
      let room = limit - 1 - used - widest;
      if (room < Math.min(total - sent, 4096) && used > 0) {
        yield take();
        room = limit - 1 - widest;
      }
      const size = Math.min(total - sent, room);
      const last = sent + size === total;
      const fields = {
        op: "file",
        path,
        mode: last ? file.mode : file.mode | 0o600,
        mtime: file.mtime,
        size,
        ...(sent > 0 ? { append: true } : {}),
      };
      const full = add(header(fields), file.data.subarray(sent, sent + size));
      if (full) yield full;
      sent += size;
    } while (sent < total);
  }
  const settle = [
    ...folders.map(({ path, mode, mtime }) => ({ path, mode, mtime })),
    ...(manifest.meta ?? []),
  ].sort((a, b) => depth(b.path) - depth(a.path));
  for (const entry of settle) {
    const full = add(
      header({
        op: "meta",
        path: escapePath(entry.path),
        mode: entry.mode,
        mtime: entry.mtime,
      }),
    );
    if (full) yield full;
  }
  if (used > 0) yield take();
}

// the push helper's last line: the frames it applied, or why it stopped
export function parsePushResult(
  stdout: string,
): { ok: true; frames: number } | { ok: false; line: string } {
  const last = stdout.trimEnd().split("\n").at(-1) ?? "";
  const done = /^PUSH ok (\d+)$/.exec(last);
  return done
    ? { ok: true, frames: Number(done[1]) }
    : { ok: false, line: last.slice(0, 200) };
}

// ---- lines, read as they arrive ----

// complete lines from a byte stream, refusing one past the cap before
// holding it
export class LineReader {
  private pending: Uint8Array[] = [];
  private size = 0;
  push(chunk: Uint8Array, line: (bytes: Uint8Array) => boolean): boolean {
    let from = 0;
    for (;;) {
      const at = chunk.indexOf(0x0a, from);
      if (at === -1) {
        this.size += chunk.byteLength - from;
        if (this.size > MAX_LINE_BYTES) return false;
        this.pending.push(chunk.subarray(from));
        return true;
      }
      if (this.size + at - from > MAX_LINE_BYTES) return false;
      this.pending.push(chunk.subarray(from, at));
      const whole = Buffer.concat(this.pending);
      this.pending = [];
      this.size = 0;
      if (!line(whole)) return false;
      from = at + 1;
    }
  }
  get empty() {
    return this.size === 0;
  }
}
