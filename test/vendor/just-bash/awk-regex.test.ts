// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The calls we added to the vendored regex layer for awk, which answer
// offsets rather than strings, and awk's turn of them into characters.

import { describe, expect, test } from "bun:test";
import { charsBefore } from "../../../vendor/just-bash/src/commands/awk/chars.ts";
import { createUserRegex } from "../../../vendor/just-bash/src/regex/user-regex.ts";

describe("the regex layer's offsets", () => {
  test("scan finds the first match at or after a position", () => {
    const re = createUserRegex("-+");
    expect(re.scan("a--b-c", 0)).toEqual({ start: 1, end: 3 });
    expect(re.scan("a--b-c", 3)).toEqual({ start: 4, end: 5 });
    expect(re.scan("a--b-c", 5)).toBeNull();
  });

  test("scan answers UTF-16 offsets past an astral character", () => {
    expect(createUserRegex("b+").scan("👍bb", 0)).toEqual({ start: 2, end: 4 });
  });

  test("scan stops on an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const re = createUserRegex("a", "", { signal: controller.signal });
    expect(() => re.scan("a", 0)).toThrow("regular expression aborted");
  });
});

describe("the regex layer's group offsets", () => {
  const spans = (pattern: string, input: string) =>
    createUserRegex(pattern).groups(input);

  test("nested groups", () => {
    expect(spans("((a)(b))c", "zabc")).toEqual([
      { start: 1, end: 4 },
      { start: 1, end: 3 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  test("an optional group that did not take part is -1", () => {
    expect(spans("a(b)?c", "ac")).toEqual([
      { start: 0, end: 2 },
      { start: -1, end: -1 },
    ]);
  });

  test("a repeated group keeps its last iteration", () => {
    expect(spans("(ab)+", "xabab")).toEqual([
      { start: 1, end: 5 },
      { start: 3, end: 5 },
    ]);
  });

  test("no match is null", () => {
    expect(spans("z", "abc")).toBeNull();
  });

  test("offsets past an emoji become character positions", () => {
    const text = "👍👍abc";
    const [whole, group] = spans("(b)c", text) ?? [];
    expect(whole).toEqual({ start: 5, end: 7 });
    expect(charsBefore(text, group.start) + 1).toBe(4);
  });
});
