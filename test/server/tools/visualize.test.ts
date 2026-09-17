// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { makeVisualizeTool } from "../../../src/server/tools/builtin/visualize.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import { parseHosts, parseToolPatch } from "../../../src/server/tools/parse.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { MAX_TITLE } from "../../../src/shared/words.ts";

const registry = new Registry([makeVisualizeTool([])]);
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  now: () => 0,
  budget: { fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: { ...TOOL_CAPS, visualBytes: 16, visualSendBytes: 24, maxVisuals: 10 },
});
const run = (args: unknown, ctx = context()) =>
  registry.run(
    { id: "draw", name: "visualize", arguments: JSON.stringify(args) },
    ctx,
  );

describe("visualize", () => {
  test("the schema asks for title first and html last, with no extra fields", () => {
    const tool = makeVisualizeTool(["https://assets.test"]);
    expect(tool.parameters).toMatchObject({
      required: ["title", "html"],
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: MAX_TITLE },
        html: { type: "string" },
      },
    });
    expect(
      Object.keys(
        (tool.parameters as { properties: Record<string, unknown> }).properties,
      ),
    ).toEqual(["title", "html"]);
    for (const phrase of [
      "title first",
      "scripts last",
      "preview appears while the fragment arrives",
      "scripts run once the call is accepted",
      "https://assets.test",
      "Do not call visualize again for the same visual",
      "do not repeat its source",
    ]) {
      expect(tool.description).toContain(phrase);
    }
    expect(tool.description).not.toContain("skill");
    expect(makeVisualizeTool([]).description).toContain("inline only");
  });

  test("accepts exactly the call cap in UTF-8 and returns only the receipt", async () => {
    const ctx = context();
    const result = await run(
      { title: "  Chart  ", html: "\u00e9".repeat(8) },
      ctx,
    );
    expect(result).toEqual({
      error: false,
      content:
        'The visual "Chart" was accepted and is shown to the user. Do not call visualize again for it and do not repeat its source.',
    });
    expect(ctx.budget.visualBytes).toBe(16);
  });

  test.each(["", " ", "\n\t"])("refuses an empty fragment %j", async (html) => {
    expect(await run({ title: "Chart", html })).toEqual({
      error: true,
      content: "Error: html must be a non-empty fragment",
    });
  });

  test("refuses excess UTF-8 bytes without spending the budget", async () => {
    const ctx = context();
    expect(
      await run({ title: "Chart", html: `${"\u00e9".repeat(8)}x` }, ctx),
    ).toEqual({ error: true, content: "Error: visual exceeds 16 B" });
    expect(ctx.budget.visualBytes).toBe(0);
  });

  test("shares the send budget across calls and accepts its exact boundary", async () => {
    const ctx = context();
    const results = await Promise.all(
      ["a".repeat(16), "b".repeat(8), "c"].map((html) =>
        run({ title: "Chart", html }, ctx),
      ),
    );
    expect(results.map((result) => result.error)).toEqual([false, false, true]);
    expect(results[2]?.content).toBe(
      "Error: visuals exceed the send budget of 24 B",
    );
    expect(ctx.budget.visualBytes).toBe(24);
    expect((await run({ title: "New send", html: "c" })).error).toBe(false);
  });

  test("refuses a visual past the count cap without spending the budget", async () => {
    const ctx = context();
    ctx.caps = { ...ctx.caps, maxVisuals: 2 };
    for (const html of ["a", "b"]) {
      expect((await run({ title: "Chart", html }, ctx)).error).toBe(false);
    }
    expect(await run({ title: "Again", html: "c" }, ctx)).toEqual({
      error: true,
      content:
        "Error: visual limit reached: a send may draw 2 visuals. Answer in text instead",
    });
    expect(ctx.budget).toMatchObject({ visuals: 2, visualBytes: 2 });
  });

  test.each([
    {},
    { title: "Chart" },
    { html: "x" },
    { title: "", html: "x" },
    { title: " ", html: "x" },
    { title: "a\nb", html: "x" },
    { title: "a\u2028b", html: "x" },
    { title: "a".repeat(MAX_TITLE + 1), html: "x" },
    { title: 5, html: "x" },
    { title: "Chart", html: 5 },
    { title: "Chart", html: "x", extra: true },
  ])("invalid arguments fail with a reason: %j", async (args) => {
    const ctx = context();
    const result = await run(args, ctx);
    expect(result.error).toBe(true);
    expect(result.content).toStartWith("Error: ");
    expect(ctx.budget.visualBytes).toBe(0);
  });

  test("a stopped call cannot accept a visual", async () => {
    const ctx = context();
    ctx.signal = AbortSignal.abort(new Error("stopped"));
    expect(await run({ title: "Chart", html: "x" }, ctx)).toEqual({
      error: true,
      content: "Error: stopped",
    });
    expect(ctx.budget.visualBytes).toBe(0);
  });
});

describe("visual hosts", () => {
  test("normalizes case, trailing slash and default port, deduplicates and sorts", () => {
    expect(
      parseHosts([
        "HTTPS://Z.TEST/",
        "https://a.test",
        "https://Z.test:443",
        "https://a.test/",
      ]),
    ).toEqual(["https://a.test", "https://z.test"]);
    expect(parseHosts([])).toEqual([]);
    expect(parseHosts(["https://mirror"])).toEqual(["https://mirror"]);
    expect(parseToolPatch({ hosts: [] })).toEqual({ hosts: [] });
  });

  test.each([
    "https://assets.test/path",
    "https://assets.test/.",
    "https://assets.test?",
    "https://assets.test?q=1",
    "https://assets.test#",
    "https://*.test",
    "http://assets.test",
    "https://assets.test:8443",
    "https://assets.test;https://other.test",
    "https://assets.test https://other.test",
    " https://assets.test",
    "https://assets.test\n",
    "https://assets.test\\",
    "https://user:pass@assets.test",
    "https://@assets.test",
    "https://%61ssets.test",
    "https://[broken]",
    "https://a..test",
    "https://-a.test",
    "https://a-.test",
    "data:",
    "*",
    5,
    null,
  ])("rejects an invalid host %j", (host) => {
    expect(() => parseHosts([host])).toThrow("hosts must be");
  });

  test("caps the list at sixteen and rejects other shapes", () => {
    const hosts = Array.from({ length: 17 }, (_, i) => `https://h${i}.test`);
    expect(parseHosts(hosts.slice(0, 16))).toHaveLength(16);
    for (const value of [hosts, "https://assets.test", null, {}, 1]) {
      expect(() => parseHosts(value)).toThrow("at most 16");
    }
    expect(() => parseToolPatch({ hosts: undefined })).toThrow("hosts");
  });
});
