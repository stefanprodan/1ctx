// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import { memoryChars } from "../../../src/shared/memory.ts";
import { area, context, now, task } from "./memory.helpers.ts";

describe("memory tool refusals", () => {
  test("refusals show current entry sizes, totals and the required cuts", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const entries = [
      { topic: "First", text: "a".repeat(500) },
      { topic: "Second", text: "b".repeat(500) },
      { topic: "Last snapshot", text: "NVDA 18".padEnd(346, "x") },
      { topic: "Fourth", text: `Fourth\n${"d".repeat(336)}` },
    ];
    expect(memoryChars(entries)).toBe(1741);
    handle.work.entries = [...entries];
    const call = (args: string) =>
      tools.run(
        offered,
        { id: "edit", name: "memory_edit", arguments: args },
        context(),
      );
    const oversized = await call(
      JSON.stringify({
        action: "set",
        topic: "Last snapshot",
        text: "x".repeat(612),
      }),
    );
    expect(oversized.error).toBe(true);
    const currentNote = entries
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.topic} [${entry.text.length}/500]\n${entry.text}`,
      )
      .join("\n\n");
    expect(oversized.content).toBe(
      `Error: The text of Last snapshot is 612 characters, the limit is 500, cut 112. Split it into several topics, one set call each, or cut it.\n${currentNote}\n1,741 of 2,200 characters.`,
    );
    expect(oversized.content).not.toContain("x".repeat(612));
    handle.work.entries = [
      { topic: "First", text: "a".repeat(500) },
      { topic: "Second", text: "b".repeat(500) },
      { topic: "Third", text: "c".repeat(500) },
      { topic: "Fourth", text: "d".repeat(406) },
    ];
    expect(memoryChars(handle.work.entries)).toBe(1950);
    const full = await call(
      JSON.stringify({ action: "set", topic: "Fifth", text: "e".repeat(489) }),
    );
    const fullNote = handle.work.entries
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.topic} [${entry.text.length}/500]\n${entry.text}`,
      )
      .join("\n\n");
    expect(full.content).toBe(
      `Error: The note would be 2,450 of 2,200, free 250. Shorten or remove entries, or leave out what the next run does not need.\n${fullNote}\n1,950 of 2,200 characters.`,
    );
    expect(full.content).not.toContain("retry");
    expect(full.error).toBe(true);
    expect(full.content).not.toContain("e".repeat(489));
    handle.work.entries = [...entries];
    for (const args of [
      "{",
      "[]",
      "null",
      '{"action":"set"}',
      '{"action":"invalid"}',
      '{"action":"set","topic":"","text":"fact"}',
      '{"action":"set","topic":"Facts","text":""}',
      '{"action":"remove","topic":"missing"}',
    ]) {
      const result = await call(args);
      expect(result.error).toBe(true);
      expect(result.content).toEndWith(
        `\n${currentNote}\n1,741 of 2,200 characters.`,
      );
      expect(result.content.length).toBeLessThanOrEqual(TOOL_CAPS.resultCut);
      expect(handle.work.entries).toEqual(entries);
      expect(handle.work.operations).toEqual([]);
    }
    const saved = await call('{"action":"none"}');
    expect(saved).toEqual({
      error: false,
      content:
        "Saved for the end of the run in the project's memory. 1,741 of 2,200 characters.",
    });
  });

  test("empty-note refusals give the right fix without asking for another set", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const cases = [
      {
        args: { action: "set", topic: "NVDA run notes", text: "x".repeat(913) },
        reason:
          "The text of NVDA run notes is 913 characters, the limit is 500, cut 413. Split it into several topics, one set call each, or cut it.",
      },
      {
        args: { action: "remove", topic: "Note" },
        reason: "No entry has topic Note. Topics: (none).",
      },
      {
        args: { action: "invalid" },
        reason:
          "action must be set, remove or none. Retry with the arguments the action takes.",
      },
      {
        args: { action: "set" },
        reason:
          "topic must be text. Retry with the arguments the action takes.",
      },
    ];
    for (const fixture of cases) {
      const result = await tools.run(
        offered,
        {
          id: "edit",
          name: "memory_edit",
          arguments: JSON.stringify(fixture.args),
        },
        context(),
      );
      expect(result).toEqual({
        error: true,
        content: `Error: ${fixture.reason}\n0 of 2,200 characters.`,
      });
      expect(offered.memory!.work.entries).toEqual([]);
      expect(offered.memory!.work.operations).toEqual([]);
    }
  });

  test("an absent topic returns the working texts and the whole refusal stays under the result cut", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    offered.memory!.work.entries = [
      { topic: "Sources", text: "Use the feed." },
    ];
    const call = {
      id: "edit",
      name: "memory_edit",
      arguments: '{"action":"remove","topic":"Note"}',
    };
    const expected =
      "Error: No entry has topic Note. Topics: Sources. Use one of the topics in the note.\n1. Sources [13/500]\nUse the feed.\n24 of 2,200 characters.";
    expect(await tools.run(offered, call, context())).toEqual({
      error: true,
      content: expected,
    });
    const cut = 120;
    expect(await tools.run(offered, call, context(cut))).toEqual({
      error: true,
      content: expected.slice(0, cut),
    });
  });
});
