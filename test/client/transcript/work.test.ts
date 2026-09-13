// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { WorkNode } from "../../../src/client/transcript/rows.ts";
import {
  counterText,
  sendCounters,
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
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: "call-1",
        name: "get_current_time",
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
    startedAt: 9_000,
    finishedAt: 61_000,
    ...changes,
  };
}

function node(changes: Partial<WorkNode> = {}): WorkNode {
  const work = message();
  return {
    kind: "work",
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
  test("uses the send counters and the answer start for elapsed time", () => {
    const summary = workSummary(node(), false);

    expect(summary).toMatchObject({
      rounds: 2,
      toolCalls: 1,
      durationMs: 51_000,
      live: false,
    });
    expect(summary.text).toBe("worked 51 s · 2 rounds · 1 tool call");
  });

  test("uses the send end when the send has no answer", () => {
    const summary = workSummary(node({ answer: null }), false);

    expect(summary.durationMs).toBe(51_000);
  });

  test("shows the live wording without an elapsed clock", () => {
    const summary = workSummary(
      node({ send: send({ status: "running", finishedAt: null }) }),
      true,
    );

    expect(summary.text).toBe("working · 1 tool call");
  });

  test("counts rounds and launched calls from the rows without a send", () => {
    const tool = (id: string, round: number, seq: number) =>
      message({
        id,
        seq,
        round,
        kind: "tool",
        slot: null,
        toolCalls: null,
        toolCallId: id,
        toolName: "websearch",
      });
    // the second round asked for two calls; a cap cut them, so no row
    const second = message({
      id: "work-2",
      seq: 4,
      round: 2,
      toolCalls: [
        { id: "call-2", name: "websearch", arguments: "{}" },
        { id: "call-3", name: "webfetch", arguments: "{}" },
      ],
    });
    const rows = [message(), tool("call-1", 1, 3), second];
    const counters = sendCounters(rows, null);

    expect(counters).toEqual({ rounds: 2, toolCalls: 1 });
    expect(counterText(counters!)).toBe("2 rounds · 1 tool call");
    expect(workSummary(node({ send: null }), false).rounds).toBe(2);
  });

  test("has no counters for a send that did no work", () => {
    const answer = message({ id: "answer-1", slot: "answer", toolCalls: null });

    expect(sendCounters([answer], send())).toBeNull();
    expect(sendCounters([message()], send({ toolCalls: 0 }))).toEqual({
      rounds: 2,
      toolCalls: 0,
    });
  });
});
