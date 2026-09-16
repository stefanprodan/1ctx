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
          failures: 0,
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
        context(45),
      );
    const first = await call("s1");
    expect(first.error).toBe(false);
    expect(first.content).toMatch(/characters left, call again$/);
    expect(offered.memory?.read?.marks.size).toBe(0);
    const other = await call("s2");
    expect(other).toMatchObject({ error: true });
    expect(other.content).toContain("finish reading s1 first");
    while (offered.memory?.read?.marks.size === 0) {
      expect((await call("s1")).error).toBe(false);
    }
    expect(offered.memory?.read?.marks.get("s1")).toBe(20);
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
        "\nChat read. Record what matters with memory_edit before the next chat.",
      ),
    ).toBe(true);
    expect(offered.memory?.read?.marks.get("s1")).toBe(20);
  });

  test("returns the note on refusals and stops after the third failure", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const failed = async () =>
      tools.run(
        offered,
        {
          id: crypto.randomUUID(),
          name: "memory_edit",
          arguments: '{"action":"remove","old_text":"missing"}',
        },
        context(),
      );
    const first = (await failed()).content;
    expect(first).toContain("The note is empty, use add.");
    expect(first).toContain("never the whole note");
    const added = await tools.run(
      offered,
      {
        id: "add",
        name: "memory_edit",
        arguments: '{"action":"add","text":"one fact"}',
      },
      context(),
    );
    expect(added.error).toBe(false);
    expect((await failed()).content).toContain("1 entries\n1. one fact");
    await failed();
    expect((await failed()).content).toContain("Stop editing and finish.");
    expect((await failed()).content).toContain("Stop editing and finish.");
    expect(offered.memory?.work.failures).toBe(3);
  });
});
