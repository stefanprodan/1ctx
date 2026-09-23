// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The calls we added to the vendored regex layer for awk, which answer
// offsets rather than strings.

import { describe, expect, test } from "bun:test";
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
