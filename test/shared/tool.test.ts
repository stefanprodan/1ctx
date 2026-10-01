// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parseArguments,
  toolArguments,
} from "../../src/shared/contracts/tool.ts";
import { isRecord } from "../../src/shared/words.ts";

describe("tool call arguments", () => {
  const cases: [string, ReturnType<typeof parseArguments>][] = [
    ["", { ok: true, args: {} }],
    ['{"a":1}', { ok: true, args: { a: 1 } }],
    ["{", { ok: false, reason: "json" }],
    ["null", { ok: false, reason: "object" }],
    ["[1]", { ok: false, reason: "object" }],
    ['"text"', { ok: false, reason: "object" }],
    ["7", { ok: false, reason: "object" }],
  ];

  for (const [text, want] of cases) {
    test(`reads ${JSON.stringify(text)}`, () => {
      expect(parseArguments(text)).toEqual(want);
      expect(toolArguments(text)).toEqual(want.ok ? want.args : null);
    });
  }
});

describe("isRecord", () => {
  test("takes a plain object only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("a")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
