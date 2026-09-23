// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { WorkNode } from "../../../src/client/transcript/rows.ts";
import {
  capWord,
  workJustEnded,
  workSummary,
} from "../../../src/client/transcript/Work.model.ts";
import type {
  Message,
  SendSummary,
} from "../../../src/shared/contracts/session.ts";

function message(changes: Partial<Message> = {}): Message {
  return {
    id: "work-1",
    sessionId: "session-1",
    seq: 2,
    kind: "reply",
    sendId: "send-1",
    round: 1,
    slot: "work",
    userId: null,
    agentId: "agent-1",
    content: "",
    resultBytes: null,
    uploads: null,
    files: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: "call-1",
        name: "datetime",
        arguments: '{"timezone":"UTC"}',
      },
    ],
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
    sessionId: "session-1",
    kind: "chat",
    userId: "user-1",
    agentId: "agent-1",
    providerId: "provider-1",
    model: "model",
    status: "done",
    cause: "finish",
    error: null,
    firstMessageId: "user-message-1",
    rounds: 2,
    toolCalls: 1,
    memoryRound: null,
    memoryError: null,
    memorySkipped: null,
    tokens: 0,
    startedAt: 9_000,
    finishedAt: 61_000,
    ...changes,
  };
}

function node(changes: Partial<WorkNode> = {}): WorkNode {
  const work = message();
  return {
    sendId: "send-1",
    rows: [work],
    rounds: [{ message: work, calls: [] }],
    answer: message({
      id: "answer-1",
      seq: 3,
      round: 2,
      slot: "answer",
      toolCalls: null,
      createdAt: 61_000,
      finishedAt: 62_000,
    }),
    send: send(),
    ...changes,
  };
}

describe("work summaries", () => {
  test("a cap outranks a refused repeat the loop went on from", () => {
    const repeat = message({ finishReason: "tool_repeat" });
    const cap = message({ id: "work-2", finishReason: "tool_loop" });
    expect(capWord([repeat, cap])).toBe("tool loop");
  });

  test.each([
    ["tool_limit", "tool limit"],
    ["token_limit", "token limit"],
    ["context_limit", "context full"],
    ["tool_loop", "tool loop"],
    ["tool_repeat", "repeat refused"],
  ])("names %s on the work row as %s", (finishReason, word) => {
    const work = message({ finishReason });
    const answer = message({
      id: "answer-1",
      slot: "answer",
      finishReason: "length",
      toolCalls: null,
      createdAt: 61_000,
    });
    expect(capWord([work, answer])).toBe(word);
    expect(capWord([answer])).toBeNull();
    expect(
      capWord([message({ kind: "tool", finishReason }), answer]),
    ).toBeNull();
    expect(workSummary(node({ rows: [work], answer }), false).text).toBe(
      `Worked for 51 s · 1 tool, ${word}`,
    );
    expect(answer.finishReason).toBe("length");
  });

  test("shuts only when a running send ends", () => {
    expect(workJustEnded(true, false)).toBeTrue();
    expect(workJustEnded(false, false)).toBeFalse();
    expect(workJustEnded(false, true)).toBeFalse();
    expect(workJustEnded(true, true)).toBeFalse();
  });

  test("says how long the work took and counts the launched calls", () => {
    const summary = workSummary(node(), false);

    // the answer's wait for its first token counts as work
    expect(summary).toMatchObject({
      toolCalls: 1,
      failed: 0,
      durationMs: 51_010,
      live: false,
    });
    expect(summary.text).toBe("Worked for 51 s · 1 tool");
  });

  test("a run's fold counts its own calls, not its memory phase's", () => {
    const work = message({
      toolCalls: [
        { id: "call-1", name: "get_flux_instance", arguments: "{}" },
        { id: "call-2", name: "get_latest_release", arguments: "{}" },
      ],
    });
    const tool = (id: string, seq: number) =>
      message({
        id,
        seq,
        kind: "tool",
        slot: null,
        toolCalls: null,
        toolCallId: id,
        toolName: "tool",
        finishReason: null,
      });
    const rows = [work, tool("call-1", 3), tool("call-2", 4)];
    const ran = send({ kind: "run", toolCalls: 5, memoryRound: 3 });
    const summary = workSummary(node({ rows, send: ran }), false);
    expect(summary.toolCalls).toBe(2);
    expect(summary.text).toBe("Worked for 51 s · 2 tools");
  });

  test("a send without tools worked until its answer began", () => {
    const answer = message({
      id: "answer-1",
      slot: "answer",
      toolCalls: null,
      createdAt: 10_000,
      ttftMs: 300,
      thinkingMs: 4_000,
    });
    const summary = workSummary(
      node({ rows: [], rounds: [], answer, send: null }),
      false,
    );

    expect(summary.durationMs).toBe(4_300);
    expect(summary.text).toBe("Worked for 4.3 s");
  });

  test("counts the answer's thinking into the time", () => {
    const summary = workSummary(
      node({
        answer: message({
          id: "answer-1",
          slot: "answer",
          toolCalls: null,
          createdAt: 61_000,
          ttftMs: 500,
          thinkingMs: 4_000,
        }),
      }),
      false,
    );

    expect(summary.durationMs).toBe(55_500);
  });

  test("uses the send end when the send has no answer", () => {
    const summary = workSummary(node({ answer: null }), false);

    expect(summary.durationMs).toBe(51_000);
  });

  test("runs a clock while it works, with the calls finished so far", () => {
    const running = node({
      send: send({ status: "running", finishedAt: null }),
    });
    expect(workSummary(running, true, 10_400).text).toBe("Working 0 s");
    expect(workSummary(running, true, 13_900).text).toBe("Working 3 s");
    expect(workSummary(running, true, 75_000).text).toBe("Working 1 min 5 s");

    const tool = message({
      id: "call-1",
      seq: 3,
      kind: "tool",
      slot: null,
      toolCalls: null,
      toolCallId: "call-1",
      toolName: "datetime",
    });
    const withRow = node({
      rows: [message(), tool],
      send: send({ status: "running", finishedAt: null }),
    });
    expect(workSummary(withRow, true, 40_000).text).toBe(
      "Working 30 s · 1 tool",
    );
  });

  test("names the failures and the cap that ended the loop", () => {
    const tool = (
      id: string,
      round: number,
      seq: number,
      status: "done" | "failed",
    ) =>
      message({
        id,
        seq,
        round,
        kind: "tool",
        slot: null,
        toolCalls: null,
        toolCallId: id,
        toolName: "websearch",
        status,
      });
    // the second round asked for two calls; a cap cut them, so no row
    const second = message({
      id: "work-2",
      seq: 5,
      round: 2,
      toolCalls: [
        { id: "call-2", name: "websearch", arguments: "{}" },
        { id: "call-3", name: "webfetch", arguments: "{}" },
      ],
    });
    const rows = [
      message(),
      tool("call-1", 1, 3, "failed"),
      tool("call-1b", 1, 4, "done"),
      second,
    ];
    const capped = node({
      rows,
      send: null,
      answer: message({
        id: "answer-1",
        seq: 6,
        round: 3,
        slot: "answer",
        toolCalls: null,
        finishReason: "tool_limit",
        createdAt: 61_000,
      }),
    });

    expect(capWord(rows)).toBeNull();
    expect(workSummary(capped, false).text).toBe(
      "Worked for 51 s · 2 tools, 1 failed, tool limit",
    );
    expect(
      workSummary(node({ rows, send: null, answer: null }), false).text,
    ).toBe("Worked for 10 s · 2 tools, 1 failed");
  });
});
