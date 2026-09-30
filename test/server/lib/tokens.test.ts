// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts are o200k_base's: recorded counts for fixed text, so a
// package upgrade that moves them fails here.

import { describe, expect, test } from "bun:test";
import { cutToTokens, tokens } from "../../../src/server/lib/tokens.ts";

describe("tokens", () => {
  test("counts in o200k_base", () => {
    expect(tokens("")).toBe(0);
    expect(tokens("hello world")).toBe(2);
    expect(tokens("You are a senior software tester.")).toBe(7);
  });

  test("counts a special token's text as plain text", () => {
    const text = "before <|im_start|>user hi<|im_end|> and <|endoftext|> after";
    expect(tokens(text)).toBe(tokens(text.replaceAll("|", "| ")));
    expect(tokens(`${"line\n".repeat(2000)}<|im_start|>`)).toBeGreaterThan(0);
    expect(cutToTokens("<|endoftext|> tail", 3).length).toBeGreaterThan(0);
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

describe("cutToTokens", () => {
  test("keeps a text that fits and cuts one that does not at its start", () => {
    expect(cutToTokens("hello world", 10)).toBe("hello world");
    const text = "lorem ipsum dolor sit amet\n".repeat(1000);
    const cut = cutToTokens(text, 100);
    expect(text.startsWith(cut)).toBeTrue();
    expect(tokens(cut)).toBeLessThanOrEqual(100);
    expect(tokens(cut)).toBeGreaterThan(90);
    expect(cutToTokens(text, 0)).toBe("");
    expect(cutToTokens(text, -5)).toBe("");
  });

  test("cuts the characters of a huge text before counting", () => {
    const huge = "a".repeat(64 * 1024 * 1024);
    const started = performance.now();
    const cut = cutToTokens(huge, 4000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tokens(cut)).toBeLessThanOrEqual(4000);
    expect(cut.length).toBeGreaterThan(0);
  });

  test("never ends on half a surrogate pair", () => {
    const cut = cutToTokens("\u{1F600}".repeat(500), 7);
    expect(tokens(cut)).toBeLessThanOrEqual(7);
    expect(cut.length % 2).toBe(0);
  });
});
