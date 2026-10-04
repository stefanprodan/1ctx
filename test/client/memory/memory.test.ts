// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The client's memory logic without a DOM: a run's transcript split at
// the memory round, the fold's words, the note card's words and the
// automation brief's line.

import { describe, expect, test } from "bun:test";
import { endedBy, groupRows } from "../../../src/client/transcript/rows.ts";
import {
  agentMarked,
  memorySummary,
} from "../../../src/client/transcript/Work.model.ts";
import {
  countLine,
  draftDirty,
  draftEntries,
  draftProblem,
  noteFieldOf,
  textSize,
  writerOf,
} from "../../../src/client/views/memory/Note.model.ts";
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
    uploads: null,
    files: null,
    saved: null,
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
    upstream: null,
    servedModel: null,
    nativeFinish: null,
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
    attentionRound: null,
    memoryFrom: null,
    memoryError: null,
    memorySkipped: null,
    summoned: false,
    tokens: 0,
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
  test("says updated with its time, the skipped count, or the error", () => {
    expect(memorySummary(node, false).text).toBe("Memory updated in 30 s");
    expect(memorySummary({ ...node, rows: [run[2]!] }, false).text).toBe(
      "Memory unchanged",
    );
    const none = message({
      ...run[2]!,
      toolCalls: [
        { id: "c1", name: "memory_edit", arguments: '{"action":"none"}' },
      ],
    });
    expect(memorySummary({ ...node, rows: [none, run[3]!] }, false).text).toBe(
      "Memory unchanged",
    );
    const refused = message({ ...run[3]!, status: "failed" });
    expect(
      memorySummary({ ...node, rows: [run[2]!, refused, refused] }, false).text,
    ).toBe("Memory not updated, 2 edits refused");
    expect(
      memorySummary({ ...node, send: send({ memorySkipped: 2 }) }, false).text,
    ).toBe("Memory updated in 30 s, 2 edits no longer applied");
    expect(
      memorySummary({ ...node, send: send({ memoryError: "no room" }) }, false)
        .text,
    ).toBe("Memory not updated. no room");
    expect(memorySummary(node, true, 20_000).text).toMatch(/^Updating memory/);
  });
});

describe("the fold after a run's answer", () => {
  // the step in round 2, needs_attention done or text only; the memory
  // phase in round 3, its edit done
  const step = (marked: boolean) =>
    marked
      ? [
          message({
            id: "step",
            seq: 3,
            round: 2,
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "a1",
                name: "needs_attention",
                arguments: '{"reason":"flux is not ready"}',
              },
            ],
            createdAt: 10_000,
            finishedAt: 11_000,
          }),
          message({
            id: "flag",
            seq: 4,
            kind: "tool",
            slot: null,
            round: 2,
            toolCallId: "a1",
            toolName: "needs_attention",
            content: "Marked.",
            createdAt: 11_000,
            finishedAt: 12_000,
          }),
        ]
      : [
          message({
            id: "step",
            seq: 3,
            round: 2,
            content: "ok",
            createdAt: 10_000,
            finishedAt: 12_000,
          }),
        ];
  const memory = (changed: boolean) => [
    message({ ...run[2]!, seq: 5, createdAt: 12_000, finishedAt: 20_000 }),
    message({
      ...run[3]!,
      seq: 6,
      status: changed ? "done" : "failed",
      createdAt: 20_000,
      finishedAt: 27_000,
    }),
  ];
  const fold = (rows: Message[], checked = true) => ({
    sendId: "send-1",
    rows,
    rounds: [],
    answer: null,
    send: send({
      memoryRound: checked ? 2 : 3,
      attentionRound: checked ? 2 : null,
      // the memory phase's rows are round 3, its start once it has one
      memoryFrom: rows.some((row) => row.round === 3) ? 3 : null,
      finishedAt: rows.at(-1)?.finishedAt ?? null,
    }),
  });
  // the step's reply as a failure, a timeout or a Stop left it
  const ended = (status: "failed" | "stopped") =>
    step(false).map((row) => ({ ...row, status, content: "" }));

  // done, over a run its agent marked or not
  const said = (rows: Message[], marked: boolean) =>
    memorySummary(fold(rows), false, 0, null, marked).text;

  test("names what the step and the memory phase did, and the time both took", () => {
    expect(said([...step(true), ...memory(true)], true)).toBe(
      "Marked and memory updated in 17 s",
    );
    expect(said(step(true), true)).toBe("Marked in 2.0 s");
    expect(said([...step(true), ...memory(false)], true)).toBe(
      "Marked in 17 s",
    );
    expect(
      memorySummary(fold([...step(false), ...memory(true)]), false).text,
    ).toBe("Memory updated in 17 s");
    expect(memorySummary(fold(step(false)), false).text).toBe(
      "Checked in 2.0 s",
    );
    expect(
      memorySummary(fold([...step(false), ...memory(false)]), false).text,
    ).toBe("Checked in 17 s");
  });

  test("with no step it is the memory phase's line, as before", () => {
    expect(memorySummary(fold(memory(true), false), false).text).toBe(
      "Memory updated in 15 s",
    );
    expect(memorySummary(fold(memory(false), false), false).text).toBe(
      "Memory not updated, 1 edit refused",
    );
  });

  test("a step that failed, timed out or was stopped checked nothing", () => {
    expect(memorySummary(fold(ended("failed")), false).text).toBe(
      "Not checked in 2.0 s",
    );
    expect(memorySummary(fold(ended("stopped")), false).text).toBe(
      "Not checked in 2.0 s",
    );
    expect(
      memorySummary(fold([...ended("failed"), ...memory(true)]), false).text,
    ).toBe("Not checked, memory updated in 17 s");
    expect(
      memorySummary(fold([...ended("failed"), ...memory(false)]), false).text,
    ).toBe("Not checked in 17 s");
    // a refused reason is the step working, not failing
    const refused = step(true).map((row) =>
      row.kind === "tool" ? { ...row, status: "failed" as const } : row,
    );
    expect(memorySummary(fold(refused), false).text).toBe("Checked in 2.0 s");
  });

  test("says Marked by the run's own mark, never by the step's tool row", () => {
    // the call went through but the run's end never wrote its reason,
    // as a crash before it leaves it
    expect(said(step(true), false)).toBe("Checked in 2.0 s");
    expect(said([...step(true), ...memory(true)], false)).toBe(
      "Memory updated in 17 s",
    );
    const cut = step(true).map((row) =>
      row.kind === "reply" ? { ...row, status: "stopped" as const } : row,
    );
    expect(said(cut, false)).toBe("Not checked in 2.0 s");
    expect(
      memorySummary(
        {
          ...fold(step(true)),
          send: send({
            memoryRound: 2,
            attentionRound: 2,
            memoryError: "no room",
            finishedAt: 12_000,
          }),
        },
        false,
        0,
        null,
        true,
      ).text,
    ).toBe("Marked in 2.0 s. Memory not updated. no room");
    expect(agentMarked({ attention: 1, attentionSource: "agent" })).toBeTrue();
    expect(
      agentMarked({ attention: 1, attentionSource: "runner" }),
    ).toBeFalse();
    expect(
      agentMarked({ attention: 0.9, attentionSource: "decider" }),
    ).toBeFalse();
    expect(agentMarked({ attention: null, attentionSource: null })).toBeFalse();
  });

  test("says which of them runs, by the memory phase's own start", () => {
    // the step's text reply done, the memory phase's reply streaming
    // with no edit row yet
    const streaming = message({
      ...run[2]!,
      seq: 5,
      status: "streaming",
      toolCalls: null,
      createdAt: 12_000,
      finishedAt: null,
    });
    expect(memorySummary(fold(step(false)), true, 12_000).text).toMatch(
      /^Checking/,
    );
    expect(
      memorySummary(fold([...step(false), streaming]), true, 20_000).text,
    ).toMatch(/^Updating memory/);
    expect(
      memorySummary(fold([...step(true), ...memory(true)]), true, 25_000).text,
    ).toMatch(/^Updating memory/);
    expect(memorySummary(fold(memory(true), false), true, 25_000).text).toMatch(
      /^Updating memory/,
    );
  });

  test("is one fold, the step's call first, then the memory edits", () => {
    const rows = [
      run[0]!,
      run[1]!,
      ...step(true),
      ...memory(true).map((row) => ({ ...row, round: 3 })),
    ];
    const nodes = groupRows(rows, send({ memoryRound: 2, attentionRound: 2 }));
    const reply = nodes[1];
    if (reply?.kind !== "reply") throw new Error("no reply node");
    expect(reply.message?.id).toBe("answer");
    expect(reply.work).toBeNull();
    expect(
      reply.memory?.rounds.flatMap((round) =>
        round.calls.map((call) => [call.call.name, call.result?.id]),
      ),
    ).toEqual([
      ["needs_attention", "flag"],
      ["memory_edit", "edit"],
    ]);
  });
});

describe("the note card", () => {
  const now = 1_000_000;
  const memory = (changes: Partial<Memory> = {}): Memory => ({
    agentRetired: false,
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
    session: {
      id: "s1",
      title: "digest",
      origin: "automation",
      automationId: "au1",
      automationName: "digest",
    },
    agentName: "sre",
    ...changes,
  });

  const user = {
    id: "u1",
    username: "casey",
    fullName: "",
    role: "member" as const,
  };

  test("names the agent and its chat or run, the user, or nobody", () => {
    expect(writerOf(memory(), now)).toEqual({
      kind: "agent",
      agentName: "sre",
      retired: false,
      session: {
        id: "s1",
        chat: null,
        automationId: "au1",
        automationName: "digest",
      },
      run: true,
      when: "1m ago",
    });
    // a chat's save is the agent's, though the chat's user is recorded
    const chat = {
      id: "c1",
      title: "Pricing check",
      origin: "chat" as const,
      automationId: null,
      automationName: null,
    };
    expect(
      writerOf(memory({ updatedBy: user, session: chat }), now),
    ).toMatchObject({
      kind: "agent",
      agentName: "sre",
      session: { id: "c1", chat: "Pricing check" },
      run: false,
    });
    // the chat deleted: still the agent, in a chat since deleted
    expect(
      writerOf(
        memory({ updatedBy: user, session: null, automationId: null }),
        now,
      ),
    ).toMatchObject({
      kind: "agent",
      agentName: "sre",
      session: null,
      run: false,
    });
    // a task's own note whose run is deleted
    expect(
      writerOf(memory({ session: null, automationId: "au1" }), now),
    ).toMatchObject({ kind: "agent", session: null, run: true });
    // a deleted agent's name stays, drawn as plain text
    expect(writerOf(memory({ agentRetired: true }), now)).toMatchObject({
      kind: "agent",
      agentName: "sre",
      retired: true,
    });
    // a hand edit or an undo
    expect(
      writerOf(
        memory({ session: null, agentName: null, updatedBy: user }),
        now,
      ),
    ).toEqual({ kind: "user", username: "casey", when: "1m ago" });
    expect(writerOf(memory({ updatedAt: null }), now)).toEqual({
      kind: "none",
    });
    expect(writerOf(memory({ session: null, agentName: null }), now)).toEqual({
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
