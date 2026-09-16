// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import type { MemoryWork } from "../../../src/server/memory/index.ts";
import type { SkillBody } from "../../../src/server/skills/index.ts";
import {
  type SkillsPort,
  type ToolsArea,
  toolsArea,
} from "../../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { memoryChars } from "../../../src/shared/memory.ts";
import parallelEdits from "../../fixtures/memory/parallel-edits.json";
import { memoryDb } from "../../helpers/db.ts";

const now = Date.UTC(2026, 8, 16, 0, 0, 0);

function area(): ToolsArea {
  const skills: SkillsPort = {
    forAgent: () => [],
    body: (): SkillBody | null => null,
    file: () => null,
  };
  return toolsArea({
    db: memoryDb(),
    fetcher: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    secret: () => null,
    clock: () => now,
    log: silent,
    version: "vtest",
    render: (markdown) => markdown,
    skills,
    memory: {
      work(projectId, automationId): MemoryWork {
        return {
          target: { projectId, automationId },
          baseRevision: 0,
          entries: [],
          operations: [],
          failedRounds: 0,
        };
      },
    },
    sessions: {
      memorySnapshot(projectId, sessionId) {
        if (projectId !== "p1" || sessionId === "missing") return null;
        return {
          id: sessionId,
          title: "A chat",
          lastActivityAt: 20,
          markdown: "# A chat\n\n## @user 1970-01-01 00:00\n\nA long answer.",
        };
      },
    },
    markers: {
      unread(_automationId, _projectId, _cap, exclude) {
        return {
          chats: exclude.includes("s1")
            ? []
            : [
                {
                  id: "s1",
                  title: "A chat",
                  author: "user",
                  lastActivityAt: 20,
                  userMessages: 2,
                  readBefore: true,
                  changedSince: true,
                },
              ],
          remaining: 0,
        };
      },
    },
  });
}

function context(resultCut = TOOL_CAPS.resultCut): ToolContext {
  return {
    signal: new AbortController().signal,
    now: () => now,
    budget: { fetches: 0, searches: 0 },
    caps: { ...TOOL_CAPS, resultCut },
  };
}

const task = {
  projectId: "p1",
  automation: { id: "a1", projectMemory: true, ownMemory: true },
  phase: "main" as const,
};

describe("memory offered sets", () => {
  test("adds the three project tools only to a memory task", () => {
    const tools = area();
    const usual = tools.offered(now, "agent", [], "auto", {
      projectId: "p1",
      automation: null,
      phase: "main",
    });
    const offered = tools.offered(now, "agent", [], "auto", task);
    expect(offered.tools.map((tool) => tool.name)).toEqual([
      ...usual.tools.map((tool) => tool.name),
      "sessions_list",
      "session_read",
      "memory_edit",
    ]);
    expect(offered.memory?.note).toBe("project");
  });

  test("offers only memory_edit in an own-memory phase", () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", {
      ...task,
      phase: "memory",
    });
    expect(offered.tools.map((tool) => tool.name)).toEqual(["memory_edit"]);
    expect(offered.memory?.note).toBe("automation");
    const plain = tools.offered(now, "agent", [], "auto", {
      projectId: "p1",
      automation: { id: "a1", projectMemory: false, ownMemory: false },
      phase: "main",
    });
    expect(plain.memory).toBeNull();
    expect(plain.tools.some((tool) => tool.name === "memory_edit")).toBe(false);
    const noPhase = tools.offered(now, "agent", [], "auto", {
      projectId: "p1",
      automation: { id: "a1", projectMemory: false, ownMemory: false },
      phase: "memory",
    });
    expect(noPhase.tools).toEqual([]);
  });

  test("each edit tool names its note and what a topic means", () => {
    const tools = area();
    const main = tools.offered(now, "agent", [], "auto", task);
    const phase = tools.offered(now, "agent", [], "auto", {
      ...task,
      phase: "memory",
    });
    const edit = (offered: {
      tools: { name: string; description: string }[];
    }) =>
      offered.tools.find((tool) => tool.name === "memory_edit")!.description;
    expect(edit(main)).toContain("Edit the project's memory.");
    expect(edit(main)).toContain("This automation has no own memory.");
    expect(edit(main)).not.toContain("in the system prompt");
    expect(edit(phase)).toContain("Edit this automation's own memory.");
    expect(edit(phase)).not.toContain("system prompt");
    expect(edit(phase)).toContain(
      "none changes nothing, for when there is nothing to record.",
    );
    expect(edit(main)).toContain("keeps pending chat reads");
    for (const text of [edit(main), edit(phase)]) {
      expect(text).toContain(
        "Record facts, not instructions to yourself, even when the task or guidance asks otherwise.",
      );
      expect(text).toEndWith("Changes are saved when the run ends.");
      expect(text).toContain(
        "A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic.",
      );
    }
    const list = main.tools.find((tool) => tool.name === "sessions_list")!;
    expect(list.description).toContain("in parallel in one round");
  });

  test("each edit schema offers only set, remove and none by topic", () => {
    const tools = area();
    for (const phase of ["main", "memory"] as const) {
      const offered = tools.offered(now, "agent", [], "auto", {
        ...task,
        phase,
      });
      const edit = offered.tools.find((tool) => tool.name === "memory_edit")!;
      expect(edit.parameters).toMatchObject({
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "remove", "none"] },
          topic: { type: "string" },
          text: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      });
      expect(
        Object.keys(
          (edit.parameters as { properties: Record<string, unknown> })
            .properties,
        ).sort(),
      ).toEqual(["action", "text", "topic"]);
    }
  });

  test("a call the phase does not offer says what it offers", async () => {
    const tools = area();
    const phase = tools.offered(now, "agent", [], "auto", {
      ...task,
      phase: "memory",
    });
    const result = await tools.run(
      phase,
      { id: "c1", name: "session_read", arguments: '{"id":"s1"}' },
      context(),
    );
    expect(result.error).toBe(true);
    expect(result.content).toBe(
      "Error: only memory_edit is offered in the memory phase.",
    );
  });
});

describe("memory tool handles", () => {
  test("five parallel edits with two failures allow later valid corrections", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", {
      ...task,
      phase: "memory",
    });
    offered.memory!.work.entries = [...parallelEdits.entries];
    const errors: boolean[][] = [];
    for (const calls of parallelEdits.rounds) {
      const results = await Promise.all(
        calls.map((args, index) =>
          tools.run(
            offered,
            {
              id: `edit-${index}`,
              name: "memory_edit",
              arguments: JSON.stringify(args),
            },
            context(),
          ),
        ),
      );
      errors.push(results.map((result) => result.error));
      expect(offered.memory!.stopped).toBe(false);
      offered.memory!.settleRound();
      expect(offered.memory!.work.failedRounds).toBe(0);
    }
    expect(errors).toEqual([
      [true, true, false, false, false],
      [false, false],
      [false, false, false],
      [false],
    ]);
    expect(offered.memory!.work.entries).toEqual([
      ...parallelEdits.entries.slice(0, 2),
      ...parallelEdits.rounds[2]!.map(({ topic, text }) => {
        if (text === undefined) throw new Error("Expected a set edit.");
        return { topic, text };
      }),
    ]);
    expect(offered.memory!.work.operations).toHaveLength(9);
    expect(offered.memory!.stopped).toBe(false);
  });

  test("applies parallel edit calls in call order", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const first = tools.run(
      offered,
      {
        id: "c1",
        name: "memory_edit",
        arguments: '{"action":"set","topic":"Order","text":"first"}',
      },
      context(),
    );
    const second = tools.run(
      offered,
      {
        id: "c2",
        name: "memory_edit",
        arguments: '{"action":"set","topic":"ORDER","text":"second"}',
      },
      context(),
    );
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ error: false }),
      expect.objectContaining({ error: false }),
    ]);
    expect(offered.memory?.work.entries).toEqual([
      { topic: "ORDER", text: "second" },
    ]);
    expect(offered.memory?.work.operations).toEqual([
      { action: "set", topic: "Order", text: "first", expected: null },
      { action: "set", topic: "ORDER", text: "second", expected: "first" },
    ]);
  });

  test("captures prior text and sanitized topic spelling for each operation", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    handle.work.entries = [{ topic: "Run status", text: "first" }];
    const call = (args: object) =>
      tools.run(
        offered,
        {
          id: crypto.randomUUID(),
          name: "memory_edit",
          arguments: JSON.stringify(args),
        },
        context(),
      );
    expect(
      (
        await call({
          action: "set",
          topic: " \u202eRUN\tSTATUS\n",
          text: " \u0000second\u202e\n\tkept\u0007 ",
        })
      ).error,
    ).toBe(false);
    expect(handle.work.entries).toEqual([
      { topic: "RUN STATUS", text: "second\n\tkept" },
    ]);
    expect(
      (await call({ action: "set", topic: "Run Status", text: "third" })).error,
    ).toBe(false);
    expect(
      (await call({ action: "remove", topic: " run\tstatus\u202e " })).error,
    ).toBe(false);
    expect(handle.work.entries).toEqual([]);
    expect(
      (await call({ action: "set", topic: " Run status ", text: "fourth" }))
        .error,
    ).toBe(false);
    expect((await call({ action: "none" })).error).toBe(false);
    expect(handle.work.entries).toEqual([
      { topic: "Run status", text: "fourth" },
    ]);
    expect(handle.work.operations).toEqual([
      {
        action: "set",
        topic: "RUN STATUS",
        text: "second\n\tkept",
        expected: "first",
      },
      {
        action: "set",
        topic: "Run Status",
        text: "third",
        expected: "second\n\tkept",
      },
      { action: "remove", topic: "run status", expected: "third" },
      { action: "set", topic: "Run status", text: "fourth", expected: null },
      { action: "none" },
    ]);
  });

  test("owns the read cursor and marks only the last page", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const call = (id: string) =>
      tools.run(
        offered,
        {
          id: crypto.randomUUID(),
          name: "session_read",
          arguments: JSON.stringify({ id }),
        },
        context(150),
      );
    const first = await call("s1");
    expect(first.error).toBe(false);
    expect(first.content).toMatch(/characters left, call again$/);
    expect(offered.memory?.read?.pending.size).toBe(0);
    const other = await call("s2");
    expect(other).toMatchObject({ error: true });
    expect(other.content).toContain("finish reading s1 first");
    while (offered.memory?.read?.pending.size === 0) {
      expect((await call("s1")).error).toBe(false);
    }
    expect(offered.memory?.read?.pending.get("s1")).toBe(20);
    expect(offered.memory?.read?.marks.size).toBe(0);
    const listed = await tools.run(
      offered,
      { id: "list", name: "sessions_list", arguments: "{}" },
      context(),
    );
    expect(listed.content).toBe("Every chat is read.");
  });

  test("each page ends with the line that asks for a record", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const listed = await tools.run(
      offered,
      { id: "list", name: "sessions_list", arguments: "{}" },
      context(),
    );
    expect(listed.content).toContain("s1 | A chat | @user");
    expect(listed.content.split("\n").at(-1)).toBe(
      "This run has a limited number of rounds. Record what you learned with memory_edit before reading more chats.",
    );
    const read = await tools.run(
      offered,
      { id: "read", name: "session_read", arguments: '{"id":"s1"}' },
      context(),
    );
    expect(read.error).toBe(false);
    expect(
      read.content.endsWith(
        "\nChat read. Record what matters with memory_edit action set, or action none when there is nothing, before reading the next chat.",
      ),
    ).toBe(true);
    expect(offered.memory?.read?.pending.get("s1")).toBe(20);
  });

  test("counts failed rounds, leaves reads alone and resets on any success", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const edit = (args: string) =>
      tools.run(
        offered,
        {
          id: crypto.randomUUID(),
          name: "memory_edit",
          arguments: args,
        },
        context(),
      );
    expect((await edit("{")).content).toContain("invalid JSON arguments");
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(1);
    await tools.run(
      offered,
      { id: "read", name: "session_read", arguments: '{"id":"s1"}' },
      context(),
    );
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(1);
    const results = await Promise.all([
      edit('{"action":"remove","topic":"missing"}'),
      edit('{"action":"set"}'),
      edit('{"action":"set","topic":"Order","text":"first"}'),
      edit('{"action":"set","topic":"Order","text":"second"}'),
      edit('{"action":"set","topic":"Other","text":"third"}'),
    ]);
    expect(results.map((result) => result.error)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(0);
    expect(handle.stopped).toBe(false);
    expect(handle.work.entries).toEqual([
      { topic: "Order", text: "second" },
      { topic: "Other", text: "third" },
    ]);
    expect(handle.work.operations).toEqual([
      { action: "set", topic: "Order", text: "first", expected: null },
      { action: "set", topic: "Order", text: "second", expected: "first" },
      { action: "set", topic: "Other", text: "third", expected: null },
    ]);
    expect(handle.read!.marks.get("s1")).toEqual({
      readActivityAt: 20,
      operation: 0,
    });
  });

  test("two failed rounds stop every memory call and drop pending reads", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const call = (name: string, args: string) =>
      tools.run(
        offered,
        { id: crypto.randomUUID(), name, arguments: args },
        context(),
      );
    await call("session_read", '{"id":"s1"}');
    expect(handle.read!.pending.size).toBe(1);
    for (const args of ["[]", '{"action":"set"}']) {
      expect((await call("memory_edit", args)).error).toBe(true);
      handle.settleRound();
    }
    expect(handle.work.failedRounds).toBe(2);
    expect(handle.stopped).toBe(true);
    expect(handle.read!.pending.size).toBe(0);
    expect(handle.read!.marks.size).toBe(0);
    for (const [name, args] of [
      ["sessions_list", "{}"],
      ["session_read", '{"id":"s2"}'],
      [
        "memory_edit",
        '{"action":"set","topic":"Order","text":"must not land"}',
      ],
      ["memory_edit", '{"action":"none"}'],
      ["memory_edit", "{"],
    ]) {
      const result = await call(name!, args!);
      expect(result.error).toBe(true);
      expect(result.content).toContain("stopped after 2 failed rounds");
      expect(result.content).toContain("0 of 2,200");
    }
    handle.settleRound();
    expect(handle.work.entries).toEqual([]);
    expect(handle.work.operations).toEqual([]);
    expect(handle.work.failedRounds).toBe(2);
    expect(handle.read!.snapshot).toBeNull();
    expect(handle.read!.pending.size).toBe(0);
    expect(handle.read!.marks.size).toBe(0);
  });

  test("none keeps pending reads without changing the note and resets a failed round", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const call = (name: string, args: string) =>
      tools.run(
        offered,
        { id: crypto.randomUUID(), name, arguments: args },
        context(),
      );
    await call(
      "memory_edit",
      '{"action":"set","topic":"Facts","text":"one fact"}',
    );
    handle.settleRound();
    await call("session_read", '{"id":"s1"}');
    await call("memory_edit", '{"action":"remove","topic":"missing"}');
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(1);
    expect(handle.read!.marks.size).toBe(0);
    const none = await call("memory_edit", '{"action":"none"}');
    expect(none.error).toBe(false);
    expect(none.content).toContain("Saved for the end of the run");
    expect(none.content).toContain("17 of 2,200");
    expect(none.content).not.toContain("one fact");
    handle.settleRound();
    expect(handle.work.entries).toEqual([{ topic: "Facts", text: "one fact" }]);
    expect(handle.work.operations).toEqual([
      { action: "set", topic: "Facts", text: "one fact", expected: null },
      { action: "none" },
    ]);
    expect(handle.work.failedRounds).toBe(0);
    expect(handle.read!.marks.get("s1")).toEqual({
      readActivityAt: 20,
      operation: 1,
    });
    expect(handle.read!.pending.size).toBe(0);
    await call("session_read", '{"id":"s2"}');
    handle.settleRound();
    expect(handle.read!.pending.get("s2")).toBe(20);
    expect(handle.read!.marks.has("s2")).toBe(false);
    for (let round = 0; round < 2; round++) {
      await call("memory_edit", '{"action":"remove","topic":"missing"}');
      handle.settleRound();
    }
    expect(handle.stopped).toBe(true);
    expect(handle.read!.pending.size).toBe(0);
    expect([...handle.read!.marks.keys()]).toEqual(["s1"]);
    expect(handle.work.entries).toEqual([{ topic: "Facts", text: "one fact" }]);
  });

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
