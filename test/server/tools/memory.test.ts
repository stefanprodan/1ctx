// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import parallelEdits from "../../fixtures/memory/parallel-edits.json";
import { area, context, now, task } from "./memory.helpers.ts";

describe("memory offered sets", () => {
  test("offers only memory_edit, and only in an own-memory phase", () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    expect(offered.tools.map((tool) => tool.name)).toEqual(["memory_edit"]);
    expect(offered.memory).not.toBeNull();
    const main = tools.offered(now, "agent", [], "auto", {
      ...task,
      phase: "main",
    });
    expect(main.memory).toBeNull();
    expect(main.tools.some((tool) => tool.name === "memory_edit")).toBe(false);
    const noPhase = tools.offered(now, "agent", [], "auto", {
      projectId: "p1",
      automation: { id: "a1", ownMemory: false },
      phase: "memory",
    });
    expect(noPhase.memory).toBeNull();
    expect(noPhase.tools).toEqual([]);
  });

  test("the edit tool names its note and what a topic means", () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const text = offered.tools.find(
      (tool) => tool.name === "memory_edit",
    )!.description;
    expect(text).toStartWith("Edit this automation's own memory.");
    expect(text).not.toContain("system prompt");
    expect(text).toContain(
      "none changes nothing, for when there is nothing to record.",
    );
    expect(text).toContain(
      "Record facts, not instructions to yourself, even when the task or guidance asks otherwise.",
    );
    expect(text).toEndWith("Changes are saved when the run ends.");
    expect(text).toContain(
      "A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic.",
    );
  });

  test("the edit schema offers only set, remove and none by topic", () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
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
        (edit.parameters as { properties: Record<string, unknown> }).properties,
      ).sort(),
    ).toEqual(["action", "text", "topic"]);
  });

  test.each(["datetime", "bash"])(
    "a %s call in the phase says what it offers",
    async (name) => {
      const tools = area();
      const phase = tools.offered(now, "agent", [], "auto", task);
      const result = await tools.run(
        phase,
        { id: "c1", name, arguments: '{"command":"ls"}' },
        context(),
      );
      expect(result.error).toBe(true);
      expect(result.content).toBe(
        "Error: only memory_edit is offered in the memory phase.",
      );
    },
  );
});

describe("memory tool handles", () => {
  test("five parallel edits with two failures allow later valid corrections", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
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

  test("counts failed rounds and resets on any success", async () => {
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
  });

  test("two failed rounds stop every memory call", async () => {
    const tools = area();
    const offered = tools.offered(now, "agent", [], "auto", task);
    const handle = offered.memory!;
    const call = (name: string, args: string) =>
      tools.run(
        offered,
        { id: crypto.randomUUID(), name, arguments: args },
        context(),
      );
    for (const args of ["[]", '{"action":"set"}']) {
      expect((await call("memory_edit", args)).error).toBe(true);
      handle.settleRound();
    }
    expect(handle.work.failedRounds).toBe(2);
    expect(handle.stopped).toBe(true);
    for (const [name, args] of [
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
  });

  test("none changes nothing and resets a failed round", async () => {
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
    await call("memory_edit", '{"action":"remove","topic":"missing"}');
    handle.settleRound();
    expect(handle.work.failedRounds).toBe(1);
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
    for (let round = 0; round < 2; round++) {
      await call("memory_edit", '{"action":"remove","topic":"missing"}');
      handle.settleRound();
    }
    expect(handle.stopped).toBe(true);
    expect(handle.work.entries).toEqual([{ topic: "Facts", text: "one fact" }]);
  });
});
