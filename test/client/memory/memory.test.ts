// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The client's memory logic without a DOM: a run's transcript split at
// the memory round, the fold's words, the note card's words and the
// automation brief's line.

import { describe, expect, test } from "bun:test";
import { endedBy, groupRows } from "../../../src/client/transcript/rows.ts";
import { memorySummary } from "../../../src/client/transcript/Work.model.ts";
import {
  countLine,
  draftDirty,
  draftEntries,
  draftProblem,
  noteFieldOf,
  textSize,
  writerOf,
} from "../../../src/client/views/memory/Note.model.ts";
import { memoryWords } from "../../../src/client/views/projects/Automations.model.ts";
import type { Memory } from "../../../src/shared/contracts/memory.ts";
import type {
  Message,
  SendSummary,
} from "../../../src/shared/contracts/session.ts";

function message(changes: Partial<Message> = {}): Message {
  return {
    id: "m",
    sessionId: "s1",
    seq: 1,
    kind: "reply",
    sendId: "send-1",
    round: 1,
    slot: "work",
    userId: null,
    agentId: "a1",
    content: "",
    resultBytes: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "stop",
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: "model",
    ttftMs: 10,
    thinkingMs: null,
    createdAt: 10_000,
    finishedAt: 20_000,
    ...changes,
  };
}

function send(changes: Partial<SendSummary> = {}): SendSummary {
  return {
    id: "send-1",
    sessionId: "s1",
    kind: "run",
    userId: "u1",
    agentId: "a1",
    providerId: "p1",
    model: "model",
    status: "done",
    cause: "finish",
    error: null,
    firstMessageId: "user",
    rounds: 3,
    toolCalls: 1,
    memoryRound: 3,
    memoryError: null,
    memorySkipped: null,
    startedAt: 9_000,
    finishedAt: 40_000,
    ...changes,
  };
}

// a run: the user message, an answer in round 1, then the phase's
// reply and tool row in round 3
const run = [
  message({ id: "user", seq: 1, kind: "user", slot: null, round: 1 }),
  message({ id: "answer", seq: 2, slot: "answer", round: 1 }),
  message({
    id: "phase",
    seq: 3,
    slot: "work",
    round: 3,
    finishReason: "tool_calls",
    toolCalls: [{ id: "c1", name: "memory_edit", arguments: "{}" }],
  }),
  message({
    id: "edit",
    seq: 4,
    kind: "tool",
    slot: null,
    round: 3,
    toolCallId: "c1",
    toolName: "memory_edit",
  }),
];

describe("a run's transcript", () => {
  test("the rows from the memory round on are the Memory fold", () => {
    const nodes = groupRows(run, send());
    const reply = nodes[1];
    if (reply?.kind !== "reply") throw new Error("no reply node");
    expect(reply.message?.id).toBe("answer");
    expect(reply.work).toBeNull();
    expect(reply.memory?.rows.map((r) => r.id)).toEqual(["phase", "edit"]);
    expect(reply.memory?.rounds[0]?.calls[0]?.result?.id).toBe("edit");
  });

  test("without the boundary the phase rows are work, as before", () => {
    const nodes = groupRows(run, send({ memoryRound: null }));
    const reply = nodes[1];
    if (reply?.kind !== "reply") throw new Error("no reply node");
    expect(reply.memory).toBeNull();
    expect(reply.work?.rows).toHaveLength(2);
  });

  test("a phase reply never stands for a run without an answer", () => {
    const rows = [
      run[0]!,
      message({ id: "cut", seq: 2, slot: "work", round: 1, status: "failed" }),
      message({
        id: "phase",
        seq: 3,
        slot: null,
        round: 3,
        status: "streaming",
      }),
    ];
    const nodes = groupRows(rows, send({ status: "running" }));
    const reply = nodes[1];
    if (reply?.kind !== "reply") throw new Error("no reply node");
    expect(reply.message).toBeNull();
    expect(endedBy(reply)?.id).toBe("cut");
  });
});

describe("the Memory fold's line", () => {
  const node = {
    sendId: "send-1",
    rows: [run[2]!, run[3]!],
    rounds: [],
    answer: null,
    send: send(),
  };
  test("says updated, the skipped count, or the error", () => {
    expect(memorySummary(node, false).text).toBe("Memory updated");
    expect(memorySummary({ ...node, rows: [run[2]!] }, false).text).toBe(
      "Memory unchanged",
    );
    expect(
      memorySummary({ ...node, send: send({ memorySkipped: 2 }) }, false).text,
    ).toBe("Memory updated, 2 edits no longer applied");
    expect(
      memorySummary({ ...node, send: send({ memoryError: "no room" }) }, false)
        .text,
    ).toBe("Memory not updated. no room");
    expect(memorySummary(node, true, 20_000).text).toMatch(/^Updating memory/);
  });
});

describe("the note card", () => {
  const now = 1_000_000;
  const memory = (changes: Partial<Memory> = {}): Memory => ({
    projectId: "p1",
    automationId: null,
    entries: [
      { topic: "One", text: "one" },
      { topic: "Two", text: "two" },
    ],
    previous: [{ topic: "One", text: "one" }],
    chars: 22,
    limit: 2200,
    revision: 2,
    updatedAt: now - 60_000,
    updatedBy: null,
    run: { sessionId: "s1", automationId: "au1", automationName: "digest" },
    ...changes,
  });

  test("names the run, the user, or nobody", () => {
    expect(writerOf(memory(), now)).toMatchObject({
      kind: "run",
      automationName: "digest",
      when: "1m ago",
    });
    expect(
      writerOf(
        memory({
          run: null,
          updatedBy: {
            id: "u1",
            username: "oana",
            fullName: "",
            role: "member",
          },
        }),
        now,
      ),
    ).toMatchObject({ kind: "user", username: "oana" });
    expect(writerOf(memory({ updatedAt: null }), now)).toEqual({
      kind: "none",
    });
  });

  const one = { topic: "One", text: "one" };
  const two = { topic: "Two", text: "two" };

  test("counts as the prompt renders and cleans the draft", () => {
    expect(countLine([one, two])).toBe("22 of 2,200 characters");
    expect(textSize(" one ")).toBe("3/500");
    expect(
      draftEntries([
        { topic: " One\nthing ", text: " one " },
        { topic: "", text: " " },
      ]),
    ).toEqual([{ topic: "One thing", text: "one" }]);
    expect(draftDirty([one, two], [one, two])).toBe(false);
    expect(draftDirty([one, two, { topic: "", text: "" }], [one, two])).toBe(
      false,
    );
    expect(draftDirty([two, one], [one, two])).toBe(true);
    // a topic's case is saved, though the diff reads it as the same topic
    expect(draftDirty([{ ...one, topic: "ONE" }, two], [one, two])).toBe(true);
  });

  test("pins a draft's refusal to the entry it names", () => {
    const blank = { topic: "", text: "" };
    expect(draftProblem([one, blank, two])).toBeNull();
    expect(draftProblem([one, blank, { topic: "", text: "x" }])).toMatchObject({
      field: "topic-3",
    });
    expect(draftProblem([one, { topic: "one", text: "again" }])).toMatchObject({
      field: "topic-2",
    });
    expect(
      draftProblem([one, { topic: "Long", text: "x".repeat(501) }]),
    ).toEqual({
      field: "text-2",
      error: "The text of Long is 501 characters, the limit is 500, cut 1.",
    });
    const full = Array.from({ length: 5 }, (_, i) => ({
      topic: `Topic ${i}`,
      text: "x".repeat(480),
    }));
    expect(draftProblem(full)?.field).toBe("text-5");
  });

  test("finds the entry a server refusal names", () => {
    const draft = [{ topic: "", text: "" }, one, two];
    expect(noteFieldOf("entries: The text of two is empty.", draft)).toBe(
      "text-3",
    );
    expect(noteFieldOf("entries: The topic of entry 1 is empty.", draft)).toBe(
      "topic-2",
    );
    expect(noteFieldOf("entries: The topic One is repeated.", draft)).toBe(
      "topic-2",
    );
    expect(
      noteFieldOf(
        "entries: The note would be 2,300 of 2,200, free 100. Cut or remove Two.",
        draft,
      ),
    ).toBe("text-3");
    expect(noteFieldOf("revision is stale", draft)).toBeUndefined();
  });
});

describe("the brief's memory line", () => {
  test("names the boxes that are on", () => {
    expect(memoryWords({ projectMemory: false, ownMemory: false })).toBeNull();
    expect(memoryWords({ projectMemory: false, ownMemory: true })).toBe(
      "Keeps its own memory.",
    );
    expect(memoryWords({ projectMemory: true, ownMemory: true })).toBe(
      "Keeps its own memory and updates project memory.",
    );
  });
});
