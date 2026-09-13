// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  DISPLAY_RESULT_CHARS,
  displayResult,
  prettyArguments,
  shortArg,
  toolSummary,
} from "../../../src/client/transcript/Tool.model.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import type { ToolCall } from "../../../src/shared/contracts/tool.ts";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "call-1",
  name,
  arguments: JSON.stringify(args),
});

function result(changes: Partial<Message> = {}): Message {
  return {
    id: "tool-1",
    sessionId: "session-1",
    seq: 3,
    kind: "tool",
    sendId: "send-1",
    round: 1,
    slot: null,
    userId: null,
    agentId: null,
    content: "result",
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: null,
    toolCalls: null,
    toolCallId: "call-1",
    toolName: "get_current_time",
    model: null,
    ttftMs: null,
    thinkingMs: null,
    createdAt: 1_000,
    finishedAt: 4_240,
    ...changes,
  };
}

describe("tool summaries", () => {
  test("picks the telling argument for each built-in", () => {
    expect(
      shortArg("webfetch", '{"url":"https://example.invalid/docs/page?q=1"}'),
    ).toBe("example.invalid/docs/page");
    expect(shortArg("websearch", '{"query":"  two   words  "}')).toBe(
      "two words",
    );
    expect(
      shortArg("get_current_time", '{"timezone":"Europe/Bucharest"}'),
    ).toBe("Europe/Bucharest");
  });

  test("shows a duration only for a completed result", () => {
    expect(toolSummary(call("get_current_time", {}), result())).toEqual({
      argument: "",
      state: "3.2 s",
      live: false,
    });
    expect(
      toolSummary(
        call("websearch", { query: "now" }),
        result({ status: "failed" }),
      ),
    ).toMatchObject({ state: "failed", live: false });
    expect(
      toolSummary(
        call("websearch", { query: "now" }),
        result({ status: "streaming", finishedAt: null }),
      ),
    ).toMatchObject({ state: "running", live: true });
    expect(
      toolSummary(call("websearch", { query: "now" }), null),
    ).toMatchObject({ state: "not run", live: false });
  });

  test("pretty prints valid arguments and preserves malformed ones", () => {
    expect(prettyArguments('{"query":"now"}')).toBe('{\n  "query": "now"\n}');
    expect(prettyArguments("{")).toBe("{");
  });

  test("cuts a displayed result without interpreting it", () => {
    const unsafe = `<b>${"x".repeat(DISPLAY_RESULT_CHARS)}</b>`;
    const shown = displayResult(result({ content: unsafe }));

    expect(shown.length).toBe(DISPLAY_RESULT_CHARS + 4);
    expect(shown.endsWith("\n...")).toBeTrue();
  });
});
