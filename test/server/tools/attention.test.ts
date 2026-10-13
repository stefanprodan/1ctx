// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// attention is a verdict: needed true takes a reason of one line of 1 to
// 200 characters, counted as characters, cleaned of control characters,
// and never a placeholder; needed false drops any reason. Its
// description adds the automation's words when it has them.

import { describe, expect, test } from "bun:test";
import {
  ATTENTION_DESCRIPTION,
  attentionDescription,
  checkReason,
  makeAttentionTool,
} from "../../../src/server/tools/builtin/attention.ts";
import { MAX_ATTENTION_REASON } from "../../../src/shared/words.ts";

describe("the reason", () => {
  test("is one line, trimmed and cleaned", () => {
    expect(checkReason("  podinfo is not ready \n")).toBe(
      "podinfo is not ready",
    );
    expect(checkReason("a\u0000b")).toBe("ab");
    for (const bad of ["", " \t ", "a\nb", "a\rb", "a b", null, 3]) {
      expect(() => checkReason(bad)).toThrow("reason must be one line.");
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
      expect(() => checkReason(filler)).toThrow("not a placeholder");
    }
    for (const real of [
      "test-flux is not ready",
      "podinfo: none of its pods are ready",
      "the ok check failed",
      "n/a: the cluster was unreachable",
    ]) {
      expect(checkReason(real)).toBe(real);
    }
  });

  test("a long one is cut to the cap in characters, not code units", () => {
    const emoji = "\u{1F525}".repeat(MAX_ATTENTION_REASON);
    expect(checkReason(emoji)).toBe(emoji);
    const cut = checkReason(`${emoji}x`)!;
    expect([...cut]).toHaveLength(MAX_ATTENTION_REASON);
    expect(cut.endsWith("…")).toBeTrue();
  });
});

describe("the tool", () => {
  const fresh = () => ({
    guidance: "",
    reason: null as string | null,
    answered: false,
  });

  test("takes needed and a reason, needed alone required", () => {
    const tool = makeAttentionTool(fresh());
    expect(tool.name).toBe("attention");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        needed: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["needed"],
      additionalProperties: false,
    });
  });

  test("answers Marked. for true and keeps the last reason", async () => {
    const handle = fresh();
    const tool = makeAttentionTool(handle);
    expect(tool.description).toBe(ATTENTION_DESCRIPTION);
    const ctx = {} as Parameters<typeof tool.run>[1];
    expect(await tool.run({ needed: true, reason: "first" }, ctx)).toBe(
      "Marked.",
    );
    expect(await tool.run({ needed: true, reason: "second" }, ctx)).toBe(
      "Marked.",
    );
    expect(handle).toEqual({ guidance: "", reason: "second", answered: true });
  });

  test("answers Checked. for false and drops its reason", async () => {
    const handle = fresh();
    const tool = makeAttentionTool(handle);
    const ctx = {} as Parameters<typeof tool.run>[1];
    expect(
      await tool.run({ needed: false, reason: "No proposals deleted" }, ctx),
    ).toBe("Checked.");
    expect(handle).toEqual({ guidance: "", reason: null, answered: true });
  });

  test("the last valid verdict holds", async () => {
    const handle = fresh();
    const tool = makeAttentionTool(handle);
    const ctx = {} as Parameters<typeof tool.run>[1];
    await tool.run({ needed: true, reason: "flux is behind" }, ctx);
    await tool.run({ needed: false }, ctx);
    expect(handle.reason).toBeNull();
    await tool.run({ needed: true, reason: "flux is behind" }, ctx);
    expect(handle.reason).toBe("flux is behind");
    await expect(tool.run({ needed: false, reason: 3 }, ctx)).resolves.toBe(
      "Checked.",
    );
    expect(handle.reason).toBeNull();
  });

  test("refuses a bad needed or a bad reason on true", async () => {
    const handle = fresh();
    const tool = makeAttentionTool(handle);
    const ctx = {} as Parameters<typeof tool.run>[1];
    for (const needed of [undefined, "true", 1, null]) {
      await expect(
        tool.run({ needed, reason: "flux is behind" }, ctx),
      ).rejects.toThrow("needed must be true or false.");
    }
    await expect(tool.run({ needed: true }, ctx)).rejects.toThrow(
      "needed true takes a one-line reason.",
    );
    await expect(
      tool.run({ needed: true, reason: "a\nb" }, ctx),
    ).rejects.toThrow("reason must be one line.");
    await expect(
      tool.run({ needed: true, reason: "placeholder-not-called" }, ctx),
    ).rejects.toThrow(
      "reason must say what a user should act on, not a placeholder.",
    );
    expect(handle.answered).toBeFalse();
    await tool.run({ needed: true, reason: "kept" }, ctx);
    await expect(tool.run({ needed: true, reason: "" }, ctx)).rejects.toThrow(
      "reason must be one line.",
    );
    expect(handle).toEqual({ guidance: "", reason: "kept", answered: true });
  });

  test("states the cap and the verdict in its description", () => {
    expect(ATTENTION_DESCRIPTION).toBe(
      `Give your verdict on this run. needed true, with a one-line reason a user reads, at most ${MAX_ATTENTION_REASON} characters, when the run found something a user should act on, or could not do its job; needed false, with no reason, when it did not. The task may say when. A later call replaces the verdict.`,
    );
  });

  test("adds the automation's words to its description", () => {
    expect(attentionDescription("")).toBe(ATTENTION_DESCRIPTION);
    expect(attentionDescription("Only when behind.")).toBe(
      `${ATTENTION_DESCRIPTION}\n\nWhen it needs attention: Only when behind.`,
    );
  });
});
