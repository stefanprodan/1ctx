// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { cutReason } from "../../../src/client/transcript/Reply.tsx";
import type { Message } from "../../../src/shared/contracts/session.ts";

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
    expect(cutReason(answer({ finishReason: "tool_limit" }))?.text).toBe(
      "tool cap reached",
    );
    expect(cutReason(answer({ finishReason: "tool_loop" }))?.text).toBe(
      "tool loop cut",
    );
  });
});
