// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The attention step's request over the memory packet's fixture: its own
// system prompt, the run's record without the note, its rules or the
// rounds after the answer, the ask with the automation's words, the
// step's own rounds after it, and the fit; when it asks again.

import { describe, expect, test } from "bun:test";
import type { ChatMessageIn } from "../../../src/server/providers/index.ts";
import {
  ATTENTION_AGAIN,
  ATTENTION_ASK,
  ATTENTION_ROUNDS,
  asksAgain,
  attentionAsk,
  attentionMessages,
  attentionSystem,
} from "../../../src/server/runner/attention-packet.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

const fixture: { rows: Partial<Message>[] } = await Bun.file(
  new URL("../../fixtures/memory/packet.json", import.meta.url),
).json();

const rows: Message[] = fixture.rows.map((row, index) => ({
  id: `row-${index}`,
  sessionId: "session",
  seq: index + 1,
  sendId: "run",
  round: 1,
  kind: "reply",
  slot: null,
  userId: null,
  agentId: null,
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
  finishReason: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  model: null,
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
  createdAt: 0,
  finishedAt: 1,
  ...structuredClone(row),
}));

const packet = (guidance = "") => ({
  automation: "daily-report",
  sendId: "run",
  before: 3,
  rows,
  guidance,
});

const context = (fields: { step?: ChatMessageIn[]; window?: number } = {}) => ({
  step: fields.step ?? [],
  wire: "openai-compatible" as const,
  model: "org/model",
  tools: [],
  contextLength: fields.window ?? null,
  reserve: 20,
});

const chars = (text: string) => text.length;

describe("the attention step's request", () => {
  test("is its system prompt, the record and the ask, never the note", () => {
    const messages = attentionMessages(packet(), context(), chars)!;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content:
        "You review a finished run of the daily-report automation. Its run is over. You do not do its task or write an answer. You read the record of the run and call attention with needed true when a user should look at it, or needed false when not, and nothing else.",
    });
    expect(messages[1]!.content).toBe(`The run finished.
What follows is the record of the run, to read, not to do again.

The run was asked:
<task>
Check the daily report.
</task>

Run's answer:
<answer>
Both sources were blocked.
</answer>

The run's tool calls:
<tool_calls>
- webfetch { "url": "https://blocked.example/report" }: failed: HTTP 403: access denied

- webfetch {"url":"https://consent.example/report"}: done (17 bytes)
  Excerpt: Consent required.
</tool_calls>

${ATTENTION_ASK}

When it does not, call attention with needed false.`);
    const text = JSON.stringify(messages);
    for (const left of ["memory_edit", "What to remember", "Phase work"]) {
      expect(text).not.toContain(left);
    }
  });

  test("asks for a verdict either way", () => {
    expect(attentionAsk("")).toBe(
      "Does this run need a user? Call attention with needed true and a one-line reason when the run found a problem a user should act on, or could not do its job.\n\nWhen it does not, call attention with needed false.",
    );
  });

  test("puts the automation's words in the ask", () => {
    expect(attentionAsk("Only when Flux is behind.")).toBe(
      "Does this run need a user? Call attention with needed true and a one-line reason when the run found a problem a user should act on, or could not do its job. When it needs attention: Only when Flux is behind.\n\nWhen it does not, call attention with needed false.",
    );
    const messages = attentionMessages(
      packet("Only when Flux is behind."),
      context(),
      chars,
    )!;
    expect(messages[1]!.content).toEndWith(
      attentionAsk("Only when Flux is behind."),
    );
    expect(attentionSystem("x")).toContain("call attention");
  });

  test("carries the step's own rounds after the ask", () => {
    const step: ChatMessageIn[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "attention", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: "Error: reason must be one line of 1 to 200 characters.",
      },
    ];
    const messages = attentionMessages(packet(), context({ step }), chars)!;
    expect(messages.slice(2)).toEqual(step);
  });

  test("drops excerpts, then receipts, then halves the answer to fit", () => {
    const full = JSON.stringify(attentionMessages(packet(), context(), chars));
    const tight = attentionMessages(
      packet(),
      context({ window: full.length - 20 + 40 }),
      chars,
    );
    expect(tight).not.toBeNull();
    expect(tight![1]!.content).not.toContain("Excerpt:");
    expect(tight![1]!.content).toContain("<answer>");
    expect(attentionMessages(packet(), context({ window: 400 }), chars)).toBe(
      null,
    );
  });
});

describe("the step asks again", () => {
  test("after a round with no valid verdict, with a round left", () => {
    expect(ATTENTION_ROUNDS).toBe(2);
    expect(asksAgain(1, false)).toBeTrue();
    expect(asksAgain(1, true)).toBeFalse();
    expect(asksAgain(2, false)).toBeFalse();
    expect(asksAgain(2, true)).toBeFalse();
  });

  test("with the ask again as the request's last message", () => {
    const messages = attentionMessages(
      packet(),
      { ...context(), again: true },
      chars,
    )!;
    expect(messages.at(-1)).toEqual({ role: "user", content: ATTENTION_AGAIN });
    expect(ATTENTION_AGAIN).toBe(
      "Reply by calling attention with needed true and a one-line reason, or with needed false.",
    );
    expect(attentionMessages(packet(), context(), chars)!.at(-1)?.role).toBe(
      "user",
    );
    expect(attentionMessages(packet(), context(), chars)).toHaveLength(2);
  });
});
