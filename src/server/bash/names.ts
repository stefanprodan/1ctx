// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The name rule of a chat's /tmp, pure so the command worker loads it.
// Scratch holds any bytes under any name a real filesystem takes; the
// knowledge rule is for shared docs people browse and link.

import { BadRequest, Conflict } from "../lib/errors.ts";

// Linux's NAME_MAX. The shell's tree walks grow with depth times
// entries, so a deeper cap lets one command make a /tmp no later command
// can list or remove within its deadline. Together they keep a name
// under Linux's PATH_MAX.
export const MAX_SCRATCH_SEGMENT_BYTES = 255;
export const MAX_SCRATCH_SEGMENTS = 16;
export const MAX_SCRATCH_NAME_BYTES =
  MAX_SCRATCH_SEGMENTS * (MAX_SCRATCH_SEGMENT_BYTES + 1) - 1;

// the longest absolute path in the mount, a /tmp path at the cap
export const MAX_MOUNT_PATH_BYTES = "/tmp/".length + MAX_SCRATCH_NAME_BYTES;

const WORDS = `a /tmp path must be valid Unicode with no NUL and no empty, . or .. part, at most ${MAX_SCRATCH_SEGMENTS} parts of ${MAX_SCRATCH_SEGMENT_BYTES} bytes each`;

// a name under /tmp, without the root: case-sensitive, any character
// but NUL, since it is stored as a row's text key
export function isScratchName(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  // a UTF-16 unit is at least a byte, so this refuses a huge string unsplit
  if (value.length > MAX_SCRATCH_NAME_BYTES) return false;
  // a lone surrogate would be stored as U+FFFD, another name
  if (!value.isWellFormed() || value.includes("\u0000")) return false;
  const parts = value.split("/");
  return (
    parts.length <= MAX_SCRATCH_SEGMENTS &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part) <= MAX_SCRATCH_SEGMENT_BYTES,
    )
  );
}

export function parseScratchName(value: unknown): string {
  if (!isScratchName(value)) throw new BadRequest(WORDS);
  return value;
}

// the file among names that stands where name has a folder, or null;
// one lookup per segment, so a tree checks in time linear in its paths
function parentFile(name: string, names: ReadonlySet<string>): string | null {
  for (let at = name.indexOf("/"); at >= 0; at = name.indexOf("/", at + 1)) {
    const parent = name.slice(0, at);
    if (names.has(parent)) return parent;
  }
  return null;
}

// every name by the rule, and no file where another has a folder
export function checkScratchNames(names: readonly string[]): void {
  for (const name of names) parseScratchName(name);
  const live = new Set(names);
  for (const name of names) {
    const other = parentFile(name, live);
    if (other !== null) {
      throw new Conflict(`${name} conflicts with file ${other}`);
    }
  }
}

// the stored names a command can mount: by the rule, and past a file
// standing where a name has a folder, since the rows were checked by
// the rule of their day and a stricter one must not lock a chat out
export function mountableScratch<T extends { path: string }>(
  entries: readonly T[],
): { kept: T[]; skipped: string[] } {
  const kept: T[] = [];
  const skipped: string[] = [];
  const live = new Set<string>();
  // a parent sorts before the names under it
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const entry of sorted) {
    if (!isScratchName(entry.path) || parentFile(entry.path, live) !== null) {
      skipped.push(entry.path);
      continue;
    }
    live.add(entry.path);
    kept.push(entry);
  }
  return { kept, skipped };
}
