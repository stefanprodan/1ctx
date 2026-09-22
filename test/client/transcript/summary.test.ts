// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  summaryLabel,
  summaryRunning,
} from "../../../src/client/transcript/Summary.model.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<Message> = {}): Message {
  return {
    id: "summary-1",
    sessionId: "session-1",
    seq: 3,
    kind: "summary",
    sendId: "send-1",
    round: 2,
    slot: null,
    userId: null,
    agentId: "agent-1",
    content: "## Goal\n- ship",
    resultBytes: null,
    uploads: null,
    files: null,
    promptTokens: 41_200,
    reasoning: "",
    html: '<h2 class="md-h2">Goal</h2>',
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

describe("the summary fold", () => {
  test("runs while the row streams or a buffer holds it", () => {
    expect(summaryRunning(summary(), new Map())).toBeFalse();
    expect(
      summaryRunning(summary({ status: "streaming" }), new Map()),
    ).toBeTrue();
    expect(summaryRunning(summary(), new Map([["summary-1", {}]]))).toBeTrue();
  });

  test("labels the clock, the tokens folded, and how it ended", () => {
    expect(summaryLabel(summary(), true, 14_500)).toEqual({
      live: true,
      text: "Summarizing 4 s",
      err: false,
    });
    expect(summaryLabel(summary(), false).text).toBe("Summarized 41K tokens");
    expect(summaryLabel(summary({ promptTokens: null }), false).text).toBe(
      "Summarized",
    );
    expect(summaryLabel(summary({ status: "stopped" }), false)).toEqual({
      live: false,
      text: "Summary stopped",
      err: false,
    });
    expect(
      summaryLabel(
        summary({ status: "failed", error: "the summary came back empty" }),
        false,
      ),
    ).toEqual({
      live: false,
      text: "Summary failed: the summary came back empty",
      err: true,
    });
    expect(summaryLabel(summary({ status: "failed" }), false).text).toBe(
      "Summary failed: failed",
    );
  });
});
