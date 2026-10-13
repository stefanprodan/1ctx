// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts are o200k_base's: recorded counts for fixed text, so a
// package upgrade that moves them fails here.

import { describe, expect, spyOn, test } from "bun:test";
import * as o200k from "gpt-tokenizer/encoding/o200k_base";
import {
  CHARS_PER_TOKEN,
  cutToTokens,
  TOKEN_PIECE,
  tokens,
} from "../../../src/server/lib/tokens.ts";

// the lengths of the texts handed to the encoder while body runs; the spy
// patches a module export, so a test using it is serial
function encoded(body: () => void): number[] {
  const encoder = spyOn(o200k, "countTokens");
  try {
    body();
    return encoder.mock.calls.map(([text]) => String(text).length);
  } finally {
    encoder.mockRestore();
  }
}

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
  test.serial("is counted in pieces cut at a line break", () => {
    const lines = "lorem ipsum dolor sit amet\n".repeat(20_000);
    // a piece boundary on a line break changes nothing
    expect(tokens(lines)).toBe(20_000 * tokens("lorem ipsum dolor sit amet\n"));
    const word = "a".repeat(256 * 1024);
    let count = 0;
    const pieces = encoded(() => {
      count = tokens(word);
    });
    expect(count).toBeGreaterThan(0);
    expect(pieces.length).toBe(word.length / TOKEN_PIECE);
    expect(Math.max(...pieces)).toBe(TOKEN_PIECE);
  });

  test.serial("a long run of whitespace is counted in pieces too", () => {
    // one pre-token to the encoder, whose merges are quadratic in it
    const run = "\t\n".repeat(40_000);
    let count = 0;
    const pieces = encoded(() => {
      count = tokens(run);
    });
    expect(count).toBeGreaterThan(0);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(TOKEN_PIECE);
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

  test.serial("cuts the characters of a huge text before counting", () => {
    const huge = "a".repeat(64 * 1024 * 1024);
    let cut = "";
    const pieces = encoded(() => {
      cut = cutToTokens(huge, 4000);
    });
    // a few counts of the cut start, never the whole text
    const handed = pieces.reduce((sum, length) => sum + length, 0);
    expect(handed).toBeLessThanOrEqual(4 * 4000 * CHARS_PER_TOKEN);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(TOKEN_PIECE);
    expect(tokens(cut)).toBeLessThanOrEqual(4000);
    expect(cut.length).toBeGreaterThan(0);
  });

  test("never ends on half a surrogate pair", () => {
    const cut = cutToTokens("\u{1F600}".repeat(500), 7);
    expect(tokens(cut)).toBeLessThanOrEqual(7);
    expect(cut.length % 2).toBe(0);
  });
});
