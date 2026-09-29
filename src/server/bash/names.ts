// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The name rule of a chat's /tmp, pure so the command worker loads it.
// Scratch holds any bytes under any name a real filesystem takes; the
// knowledge rule is for shared docs people browse and link.

import { checkNames } from "../knowledge/rules.ts";
import { BadRequest } from "../lib/errors.ts";

// Linux's NAME_MAX and PATH_MAX; the depth keeps the prefix check over
// a tree's names small, and no real archive nests deeper
export const MAX_SCRATCH_SEGMENT_BYTES = 255;
export const MAX_SCRATCH_SEGMENTS = 64;
export const MAX_SCRATCH_NAME_BYTES = 4096;

// the longest absolute path in the mount, a /tmp path at the cap
export const MAX_MOUNT_PATH_BYTES = "/tmp/".length + MAX_SCRATCH_NAME_BYTES;

const WORDS = `a /tmp path must be valid Unicode with no NUL and no empty, . or .. part, at most ${MAX_SCRATCH_SEGMENTS} parts of ${MAX_SCRATCH_SEGMENT_BYTES} bytes each and ${MAX_SCRATCH_NAME_BYTES} bytes in all`;

// a name under /tmp, without the root: case-sensitive, any character
// but NUL, since it is stored as a row's text key
export function isScratchName(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  // a lone surrogate would be stored as U+FFFD, another name
  if (!value.isWellFormed() || value.includes("\u0000")) return false;
  if (Buffer.byteLength(value) > MAX_SCRATCH_NAME_BYTES) return false;
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

// every name by the rule, and no file where another has a folder
export function checkScratchNames(names: readonly string[]): void {
  for (const name of names) parseScratchName(name);
  checkNames(names);
}
