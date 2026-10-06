// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { cutAt, cutCodePoints, oneLine } from "../../src/shared/text.ts";

describe("cutAt", () => {
  test.each([
    ["abc", 3, "abc"],
    ["abcd", 3, "abc"],
    ["abc", 0, ""],
    ["abc", -1, ""],
    ["ab\u{1F600}", 3, "ab"],
    ["ab\u{1F600}", 4, "ab\u{1F600}"],
  ])("cuts %p at %p to %p", (text, chars, expected) => {
    expect(cutAt(text, chars)).toBe(expected);
  });
});

test("cutCodePoints counts an emoji as one", () => {
  expect(cutCodePoints("\u{1F600}\u{1F600}b", 2)).toBe("\u{1F600}\u{1F600}");
  expect(cutCodePoints("abc", 5)).toBe("abc");
});

test("oneLine folds whitespace", () => {
  expect(oneLine("  a \n\t b  ")).toBe("a b");
});
