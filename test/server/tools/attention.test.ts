// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// needs_attention's reason is one line of 1 to 200 characters, counted
// as characters, cleaned of control characters, and never a placeholder;
// its description adds the automation's words when it has them.

import { describe, expect, test } from "bun:test";
import {
  ATTENTION_DESCRIPTION,
  attentionDescription,
  makeAttentionTool,
  parseReason,
} from "../../../src/server/tools/builtin/attention.ts";
import { MAX_ATTENTION_REASON } from "../../../src/shared/words.ts";

describe("the reason", () => {
  test("is one line, trimmed and cleaned", () => {
    expect(parseReason("  podinfo is not ready \n")).toBe(
      "podinfo is not ready",
    );
    expect(parseReason("a\u0000b")).toBe("ab");
    for (const bad of ["", " \t ", "a\nb", "a\rb", "a b", null, 3]) {
      expect(parseReason(bad)).toBeNull();
    }
  });

  test("is never a placeholder", () => {
    for (const filler of [
      "placeholder-not-called",
      "PLACEHOLDER",
      "a placeholder reason",
      "test",
      " TODO ",
      "dummy",
      "None",
      "n/a",
      "N/A.",
      "null",
      "ok",
      "OK!",
      "test - todo",
      "none / null",
      "[placeholder]",
    ]) {
      expect(parseReason(filler)).toBeNull();
    }
    for (const real of [
      "test-flux is not ready",
      "podinfo: none of its pods are ready",
      "the ok check failed",
      "n/a: the cluster was unreachable",
    ]) {
      expect(parseReason(real)).toBe(real);
    }
  });

  test("a long one is cut to the cap in characters, not code units", () => {
    const emoji = "\u{1F525}".repeat(MAX_ATTENTION_REASON);
    expect(parseReason(emoji)).toBe(emoji);
    const cut = parseReason(`${emoji}x`)!;
    expect([...cut]).toHaveLength(MAX_ATTENTION_REASON);
    expect(cut.endsWith("…")).toBeTrue();
  });
});

describe("the tool", () => {
  test("answers Marked. and keeps the last reason", async () => {
    const handle = { guidance: "", reason: null as string | null };
    const tool = makeAttentionTool(handle);
    expect(tool.description).toBe(ATTENTION_DESCRIPTION);
    const ctx = {} as Parameters<typeof tool.run>[1];
    expect(await tool.run({ reason: "first" }, ctx)).toBe("Marked.");
    expect(await tool.run({ reason: "second" }, ctx)).toBe("Marked.");
    expect(handle.reason).toBe("second");
    await expect(tool.run({ reason: "" }, ctx)).rejects.toThrow(
      "reason must be one line.",
    );
    await expect(
      tool.run({ reason: "placeholder-not-called" }, ctx),
    ).rejects.toThrow(
      "reason must say what a user should act on, not a placeholder.",
    );
    expect(handle.reason).toBe("second");
  });

  test("adds the automation's words to its description", () => {
    expect(attentionDescription("")).toBe(ATTENTION_DESCRIPTION);
    expect(attentionDescription("Only when behind.")).toBe(
      `${ATTENTION_DESCRIPTION}\n\nWhen it needs attention: Only when behind.`,
    );
  });
});
