// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts are o200k_base's: recorded counts for fixed text, so a
// package upgrade that moves them fails here.

import { describe, expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";

describe("tokens", () => {
  test("counts in o200k_base", () => {
    expect(tokens("")).toBe(0);
    expect(tokens("hello world")).toBe(2);
    expect(tokens("You are a senior software tester.")).toBe(7);
  });
});

describe("long text", () => {
  test("is counted in pieces cut at a line break, in milliseconds", () => {
    const lines = "lorem ipsum dolor sit amet\n".repeat(20_000);
    // a piece boundary on a line break changes nothing
    expect(tokens(lines)).toBe(20_000 * tokens("lorem ipsum dolor sit amet\n"));
    const word = "a".repeat(256 * 1024);
    const started = performance.now();
    expect(tokens(word)).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a long run of whitespace is counted in pieces too", () => {
    // one pre-token to the encoder, whose merges are quadratic in it
    const run = "\t\n".repeat(40_000);
    const started = performance.now();
    expect(tokens(run)).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
