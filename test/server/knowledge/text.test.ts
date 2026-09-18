// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  lineCount,
  textFromBytes,
  textFromString,
} from "../../../src/server/knowledge/text.ts";
import {
  textFromBytes as sharedBytes,
  textFromString as sharedString,
} from "../../../src/shared/knowledge.ts";
import fixtures from "../../fixtures/knowledge/text.json";

describe("knowledge text lines", () => {
  test.each(fixtures.filter((fixture) => !fixture.invalid))(
    "$name",
    (fixture) => {
      expect(lineCount(fixture.expected!)).toBe(fixture.lines!);
    },
  );

  test("re-exports the shared text rules for server callers", () => {
    expect(textFromBytes).toBe(sharedBytes);
    expect(textFromString).toBe(sharedString);
  });

  test("counts the last line once, with or without a newline", () => {
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\n")).toBe(1);
    expect(lineCount("one\ntwo")).toBe(2);
    expect(lineCount("\n\n")).toBe(2);
  });
});
