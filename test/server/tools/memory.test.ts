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

  test("each edit tool names its note and how an entry is named", () => {
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
    expect(edit(main)).toContain("this automation's own memory");
    expect(edit(phase)).toContain("Edit this automation's own memory.");
    expect(edit(phase)).toContain("the project memory");
    for (const text of [edit(main), edit(phase)]) {
      expect(text).toContain("a different note this tool never edits");
      expect(text).toContain("add appends one entry");
      expect(text).toContain("never the whole note");
    }
    const list = main.tools.find((tool) => tool.name === "sessions_list")!;
    expect(list.description).toContain("in parallel in one round");
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
  test("accepts valid corrections after a round of parallel refusals", async () => {
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
      offered.memory!.settleRound();
    }
    expect(errors).toEqual([
      [true, true, true, true, true],
      [false, false, true],
      [true, true, false],
      [true],
    ]);
    expect(offered.memory!.work.entries).toEqual([
      ...parallelEdits.entries.slice(0, 2),
      parallelEdits.rounds[1]![0]!.text,
      parallelEdits.rounds[1]![1]!.text,
      parallelEdits.rounds[2]![2]!.text,
    ]);
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
        arguments: '{"action":"add","text":"first"}',
      },
      context(),
    );
    const second = tools.run(
      offered,
      {
        id: "c2",
        name: "memory_edit",
        arguments: '{"action":"add","text":"second"}',
      },
      context(),
    );
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ error: false }),
      expect.objectContaining({ error: false }),
    ]);
    expect(offered.memory?.work.entries).toEqual(["first", "second"]);
    expect(offered.memory?.work.operations).toHaveLength(2);
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
        "\nChat read. Record what matters with memory_edit, or call it with action none when there is nothing, before reading the next chat.",
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
      edit('{"action":"remove","old_text":"missing"}'),
      edit('{"action":"replace"}'),
      edit('{"action":"add","text":"first"}'),
      edit('{"action":"replace","old_text":"first","text":"second"}'),
      edit('{"action":"add","text":"third"}'),
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
    expect(handle.work.entries).toEqual(["second", "third"]);
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
    for (const args of ["[]", '{"action":"replace"}']) {
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
      ["memory_edit", '{"action":"add","text":"must not land"}'],
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
    await call("memory_edit", '{"action":"add","text":"one fact"}');
    handle.settleRound();
    await call("session_read", '{"id":"s1"}');
    await call("memory_edit", '{"action":"remove","old_text":"missing"}');
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(1);
    expect(handle.read!.marks.size).toBe(0);
    const none = await call("memory_edit", '{"action":"none"}');
    expect(none.error).toBe(false);
    expect(none.content).toContain("Saved for the end of the run");
    expect(none.content).toContain("8 of 2,200");
    expect(none.content).not.toContain("one fact");
    handle.settleRound();
    expect(handle.work.entries).toEqual(["one fact"]);
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
      await call("memory_edit", '{"action":"remove","old_text":"missing"}');
      handle.settleRound();
    }
    expect(handle.stopped).toBe(true);
    expect(handle.read!.pending.size).toBe(0);
    expect([...handle.read!.marks.keys()]).toEqual(["s1"]);
    expect(handle.work.entries).toEqual(["one fact"]);
  });

  test("refusals show current entry sizes, totals and the required cuts", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const entries = [
      "a".repeat(500),
      "b".repeat(500),
      "Last snapshot: NVDA 18".padEnd(346, "x"),
      `Fourth\n${"d".repeat(379)}`,
    ];
    handle.work.entries = [...entries];
    const call = (args: string) =>
      tools.run(
        offered,
        { id: "edit", name: "memory_edit", arguments: args },
        context(),
      );
    const oversized = await call(
      JSON.stringify({ action: "add", text: "x".repeat(612) }),
    );
    expect(oversized.error).toBe(true);
    expect(oversized.content).toContain(
      "An entry is 612 characters, the limit is 500, cut 112.",
    );
    expect(oversized.content).toContain("1,741 of 2,200");
    expect(oversized.content).toContain("[346/500]");
    expect(oversized.content).toContain("3. Last snapshot: NVDA 18");
    expect(oversized.content).toContain("4. Fourth [386/500]");
    expect(oversized.content).not.toContain("x".repeat(100));
    expect(oversized.content).not.toContain("x".repeat(612));
    handle.work.entries = [
      "a".repeat(500),
      "b".repeat(500),
      "c".repeat(500),
      "d".repeat(441),
    ];
    const full = await call(
      JSON.stringify({ action: "add", text: "e".repeat(497) }),
    );
    expect(full.content).toContain(
      "The note would be 2,450 of 2,200, free 250.",
    );
    expect(full.content).toContain("1,950 of 2,200");
    expect(full.content).not.toContain("e".repeat(497));
    handle.work.entries = [...entries];
    for (const args of [
      "{",
      "[]",
      "null",
      '{"action":"replace"}',
      '{"action":"invalid"}',
      '{"action":"remove","old_text":"missing"}',
    ]) {
      const result = await call(args);
      expect(result.error).toBe(true);
      expect(result.content).toContain("1,741 of 2,200");
      for (const [index, entry] of entries.entries()) {
        expect(result.content).toContain(`${index + 1}. `);
        expect(result.content).toContain(`[${entry.length}/500]`);
      }
      expect(result.content.length).toBeLessThanOrEqual(TOOL_CAPS.resultCut);
      expect(handle.work.entries).toEqual(entries);
    }
    const saved = await call('{"action":"none"}');
    expect(saved).toEqual({
      error: false,
      content:
        "Saved for the end of the run in the project's memory. 1,741 of 2,200 characters.",
    });
  });
});
