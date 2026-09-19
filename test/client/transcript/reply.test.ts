// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  cutReason,
  emptyFailure,
  replyRunning,
} from "../../../src/client/transcript/Reply.tsx";
import type {
  ReplyNode,
  WorkNode,
} from "../../../src/client/transcript/rows.ts";
import { liveOf } from "../../../src/client/transcript/stream.ts";
import type {
  Message,
  SendSummary,
} from "../../../src/shared/contracts/session.ts";

function answer(changes: Partial<Message> = {}): Message {
  return {
    id: "answer-1",
    sessionId: "session-1",
    seq: 4,
    kind: "reply",
    sendId: "send-1",
    round: 2,
    slot: "answer",
    userId: null,
    agentId: "agent-1",
    content: "done",
    resultBytes: null,
    uploads: null,
    promptTokens: null,
    reasoning: "",
    html: '<p class="md-p">done</p>',
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

function send(status: SendSummary["status"]): SendSummary {
  return {
    id: "send-1",
    sessionId: "session-1",
    kind: "chat",
    userId: "user-1",
    agentId: "agent-1",
    providerId: "provider-1",
    model: "model",
    status,
    cause: status === "running" ? null : "finish",
    error: null,
    firstMessageId: "user-1",
    rounds: 2,
    toolCalls: 1,
    memoryRound: null,
    memoryError: null,
    memorySkipped: null,
    tokens: 0,
    startedAt: 10_000,
    finishedAt: status === "running" ? null : 20_000,
  };
}

function node(summary: SendSummary | null): ReplyNode {
  const message = answer();
  return {
    kind: "reply",
    sendId: "send-1",
    message,
    work: null,
    summary: null,
    memory: null,
    compact: false,
    rows: [message],
    send: summary,
  };
}

describe("an agent turn's running state", () => {
  test("trusts a terminal send over a stale live row", () => {
    const finished = node(send("done"));
    const message = finished.message;
    if (message === null) throw new Error("expected reply");
    const live = new Map([[message.id, liveOf(message)]]);

    expect(replyRunning(finished, live)).toBeFalse();
    expect(replyRunning(node(send("running")), new Map())).toBeTrue();
    expect(replyRunning(node(null), live)).toBeTrue();
  });
});

describe("the line under an answer", () => {
  test("says how a send was cut short, and nothing for a plain end", () => {
    expect(cutReason(answer())).toBeNull();
    expect(cutReason(answer({ status: "stopped" }))).toEqual({
      text: "stopped",
      err: false,
    });
    expect(
      cutReason(answer({ status: "failed", error: "the provider went away" })),
    ).toEqual({ text: "the provider went away", err: true });
    expect(cutReason(answer({ finishReason: "length" }))?.text).toBe(
      "cut at max tokens",
    );
    // a cap is the work fold's word, not this line's
    expect(cutReason(answer({ finishReason: "tool_limit" }))).toBeNull();
    expect(cutReason(answer({ finishReason: "token_limit" }))).toBeNull();
    expect(cutReason(answer({ finishReason: "context_limit" }))).toBeNull();
    expect(cutReason(answer({ finishReason: "tool_loop" }))).toBeNull();
  });
});

describe("a failed turn's fold", () => {
  const work = (changes: Partial<WorkNode> = {}): WorkNode => ({
    sendId: "send-1",
    rows: [],
    rounds: [],
    answer: null,
    send: null,
    ...changes,
  });
  const failed = answer({
    status: "failed",
    error: "OpenRouter 403: not available",
    content: "",
    html: "",
  });

  test("is left out when the send failed before doing anything", () => {
    expect(emptyFailure(work(), failed, "OpenRouter 403", "")).toBeTrue();
  });

  test("stays when there is work, thinking, words or no failure", () => {
    expect(
      emptyFailure(work({ rows: [failed] }), failed, "OpenRouter 403", ""),
    ).toBeFalse();
    expect(
      emptyFailure(
        work(),
        { ...failed, reasoning: "thinking" },
        "OpenRouter 403",
        "",
      ),
    ).toBeFalse();
    expect(emptyFailure(work(), failed, "OpenRouter 403", "half")).toBeFalse();
    expect(emptyFailure(work(), failed, null, "")).toBeFalse();
  });
});
