// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  checkScratchNames,
  isScratchName,
  MAX_SCRATCH_NAME_BYTES,
  MAX_SCRATCH_SEGMENT_BYTES,
  MAX_SCRATCH_SEGMENTS,
  parseScratchName,
} from "../../../src/server/bash/names.ts";
import { mountPath } from "../../../src/server/bash/open.ts";
import { BadRequest, Conflict } from "../../../src/server/lib/errors.ts";

describe("the scratch name rule", () => {
  test.each([
    "notes.txt",
    "my notes.txt",
    'it\'s "quoted".md',
    "a+b@c#d,e;f&g",
    "-rf",
    "--help",
    "café/ünïcode/日本語.txt",
    "emoji 🙂.png",
    "tab\tand\nline",
    "back\\slash",
    ".hidden",
    "...",
    ". a",
    "a/b/c/d/e/f/g/h/i/j",
    "Notes",
  ])("allows %p", (name) => {
    expect(isScratchName(name)).toBe(true);
    expect(parseScratchName(name)).toBe(name);
  });

  test.each([
    ["empty", ""],
    ["a leading slash", "/a"],
    ["a trailing slash", "a/"],
    ["an empty segment", "a//b"],
    ["a dot segment", "a/./b"],
    ["a dot name", "."],
    ["a dot-dot segment", "a/../b"],
    ["a dot-dot name", ".."],
    ["a NUL", "a\u0000b"],
    ["a lone surrogate", "a\ud800b"],
    ["not a string", 42],
    ["null", null],
  ])("refuses %s", (_label, name) => {
    expect(isScratchName(name)).toBe(false);
    expect(() => parseScratchName(name)).toThrow(BadRequest);
  });

  test("a segment is at most 255 bytes, counted in UTF-8", () => {
    expect(isScratchName("x".repeat(MAX_SCRATCH_SEGMENT_BYTES))).toBe(true);
    expect(isScratchName("x".repeat(MAX_SCRATCH_SEGMENT_BYTES + 1))).toBe(
      false,
    );
    expect(isScratchName(`${"é".repeat(127)}x`)).toBe(true);
    expect(isScratchName("é".repeat(128))).toBe(false);
  });

  test("a name is at most 64 segments", () => {
    const deep = (n: number) => Array(n).fill("d").join("/");
    expect(isScratchName(deep(MAX_SCRATCH_SEGMENTS))).toBe(true);
    expect(isScratchName(deep(MAX_SCRATCH_SEGMENTS + 1))).toBe(false);
  });

  test("a name is at most 4096 bytes", () => {
    // 16 segments of 250 and one of 80, with 16 slashes
    const edge = `${Array(16).fill("x".repeat(250)).join("/")}/${"y".repeat(80)}`;
    expect(Buffer.byteLength(edge)).toBe(MAX_SCRATCH_NAME_BYTES);
    expect(isScratchName(edge)).toBe(true);
    expect(isScratchName(`${edge}x`)).toBe(false);
  });

  test("the refusal names the rule", () => {
    expect(() => parseScratchName("a/../b")).toThrow(
      "a /tmp path must be valid Unicode with no NUL and no empty, . or .. part, at most 64 parts of 255 bytes each and 4096 bytes in all",
    );
  });
});

describe("a scratch tree's names", () => {
  test("names differing only in case are two files", () => {
    expect(() =>
      checkScratchNames(["Notes", "notes", "A/b", "a/b"]),
    ).not.toThrow();
  });

  test("a file and a folder cannot share a path", () => {
    expect(() => checkScratchNames(["my dir", "my dir/f"])).toThrow(Conflict);
    expect(() => checkScratchNames(["my dir/f", "my dir"])).toThrow(
      "conflicts with file",
    );
  });

  test("every name goes by the rule", () => {
    expect(() => checkScratchNames(["ok", "../out"])).toThrow(BadRequest);
  });
});

describe("a mount path", () => {
  test("takes a /tmp path at the cap and nothing longer", () => {
    const name = `${Array(16).fill("x".repeat(250)).join("/")}/${"y".repeat(80)}`;
    expect(mountPath("/tmp/my notes.md")).toBe(true);
    expect(mountPath(`/tmp/${name}`)).toBe(true);
    expect(mountPath(`/tmp/${name}y`)).toBe(false);
    expect(mountPath("/tmp/a\tb")).toBe(false);
  });
});
