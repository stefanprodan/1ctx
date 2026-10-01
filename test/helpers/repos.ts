// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Repository fixtures: tarballs written by hand as `git archive` writes
// them (a pax global header naming the commit, then a top folder), and
// a fake host that answers recorded URLs only.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const COMMIT = "3e0ff8ae123b710bc91de1315cba0f996a8896c2";
export const NEXT_COMMIT = "8d01e44a7b2f3c9d0e1f2a3b4c5d6e7f8a9b0c1d";
// the commit's time, seconds since the epoch
export const COMMIT_TIME = 1_789_989_707;

export type TarEntry = {
  name: string;
  type?: "file" | "dir" | "symlink" | "link" | "fifo";
  body?: string | Uint8Array;
  // a size the body is padded to with zeros
  size?: number;
  mode?: number;
  linkname?: string;
};

const encoder = new TextEncoder();

function field(
  block: Uint8Array,
  offset: number,
  length: number,
  text: string,
) {
  block.set(encoder.encode(text).subarray(0, length), offset);
}

function octal(block: Uint8Array, offset: number, length: number, n: number) {
  field(block, offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`);
}

const FLAGS = { file: "0", link: "1", symlink: "2", dir: "5", fifo: "6" };

function header(
  name: string,
  flag: string,
  size: number,
  mode: number,
  mtime: number,
  linkname = "",
): Uint8Array {
  const block = new Uint8Array(512);
  field(block, 0, 100, name);
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, mtime);
  block.fill(0x20, 148, 156);
  field(block, 156, 1, flag);
  field(block, 157, 100, linkname);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function pax(records: Record<string, string>): Uint8Array {
  let text = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length++;
    text += `${length}${body}`;
  }
  return encoder.encode(text);
}

function padded(bytes: Uint8Array): Uint8Array[] {
  const rest = -bytes.length & 511;
  return rest === 0 ? [bytes] : [bytes, new Uint8Array(rest)];
}

// a tar.gz; top is the folder every entry is under, comment the pax
// global header's commit (none when null)
export function tarball(
  entries: TarEntry[],
  options: { top?: string; comment?: string | null; gzip?: boolean } = {},
): Uint8Array {
  const top = options.top ?? `acme-widgets-${COMMIT.slice(0, 7)}`;
  const comment = options.comment === undefined ? COMMIT : options.comment;
  const parts: Uint8Array[] = [];
  if (comment !== null) {
    const body = pax({ comment });
    parts.push(
      header("pax_global_header", "g", body.length, 0o666, COMMIT_TIME),
    );
    parts.push(...padded(body));
  }
  parts.push(header(`${top}/`, "5", 0, 0o775, COMMIT_TIME));
  for (const entry of entries) {
    const type = entry.type ?? "file";
    let name = entry.name.startsWith("/") ? entry.name : `${top}/${entry.name}`;
    if (type === "dir" && !name.endsWith("/")) name += "/";
    const linkname =
      entry.linkname === undefined
        ? ""
        : type === "link"
          ? `${top}/${entry.linkname}`
          : entry.linkname;
    const data =
      typeof entry.body === "string"
        ? encoder.encode(entry.body)
        : (entry.body ?? new Uint8Array(entry.size ?? 0));
    const size = type === "file" ? data.length : 0;
    if (encoder.encode(name).length > 100) {
      const body = pax({ path: name });
      parts.push(header("PaxHeader", "x", body.length, 0o644, COMMIT_TIME));
      parts.push(...padded(body));
    }
    const mode = entry.mode ?? (type === "dir" ? 0o775 : 0o664);
    parts.push(header(name, FLAGS[type], size, mode, COMMIT_TIME, linkname));
    if (size > 0) parts.push(...padded(data));
  }
  parts.push(new Uint8Array(1024));
  const tar = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return options.gzip === false ? tar : Bun.gzipSync(tar);
}

export type HostCall = {
  url: string;
  headers: Record<string, string | undefined>;
};

export type HostAnswer =
  | Response
  | ((call: HostCall, init: RequestInit) => Response | Promise<Response>);

// a fetch that answers the recorded URLs and refuses every other
export function fakeHost(answers: Record<string, HostAnswer>): {
  fetch: typeof fetch;
  calls: HostCall[];
  answers: Record<string, HostAnswer>;
} {
  const calls: HostCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call = { url, headers };
    calls.push(call);
    const answer = answers[url];
    if (answer === undefined) throw new Error("no recorded answer");
    const response =
      typeof answer === "function" ? await answer(call, init ?? {}) : answer;
    return response.clone();
  }) as typeof fetch;
  return { fetch: fetcher, calls, answers };
}

export const tarResponse = (bytes: Uint8Array, etag = '"t1"') =>
  new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { etag },
  });

export const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

export function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), "1ctx-repos-"));
}
