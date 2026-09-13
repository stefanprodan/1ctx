// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  bytesWord,
  displayResult,
  prettyArguments,
  shortArg,
  toolSummary,
  wantsResult,
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
    resultBytes: 6,
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

  test("asks for the result once the row is open and the tool ended", () => {
    expect(wantsResult(true, result(), undefined)).toBeTrue();
    expect(wantsResult(false, result(), undefined)).toBeFalse();
    expect(wantsResult(true, null, undefined)).toBeFalse();
    expect(
      wantsResult(true, result({ status: "streaming" }), undefined),
    ).toBeFalse();
    expect(wantsResult(true, result(), { status: "loading" })).toBeFalse();
    expect(
      wantsResult(true, result({ status: "failed" }), undefined),
    ).toBeTrue();
  });

  test("shows the fetched result with its size and the server's cut", () => {
    expect(displayResult(result(), undefined)).toEqual({
      label: "result, untrusted",
      text: "loading",
      err: false,
    });
    expect(
      displayResult(result(), {
        status: "done",
        content: "<b>x</b>",
        bytes: 8,
        cut: false,
      }),
    ).toEqual({
      label: "result, untrusted · 8 B",
      text: "<b>x</b>",
      err: false,
    });
    expect(
      displayResult(result(), {
        status: "done",
        content: "x",
        bytes: 40_000,
        cut: true,
      }),
    ).toEqual({
      label: "result, untrusted · 40.0 KB",
      text: "x\n...",
      err: false,
    });
    expect(
      displayResult(result(), { status: "failed", error: "not found" }),
    ).toEqual({ label: "result, untrusted", text: "not found", err: true });
    expect(displayResult(result({ status: "streaming" }), undefined).text).toBe(
      "",
    );
  });

  test("words a size", () => {
    expect(bytesWord(812)).toBe("812 B");
    expect(bytesWord(2_400)).toBe("2.4 KB");
    expect(bytesWord(1_100_000)).toBe("1.1 MB");
  });
});
