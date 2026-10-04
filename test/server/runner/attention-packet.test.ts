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
  isOk,
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
        "You review a finished run of the daily-report automation. Its run is over. You do not do its task or write an answer. You read the record of the run and call needs_attention when a user should look at it, and nothing else.",
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

When it does not, reply with the word ok.`);
    const text = JSON.stringify(messages);
    for (const left of ["memory_edit", "What to remember", "Phase work"]) {
      expect(text).not.toContain(left);
    }
  });

  test("puts the automation's words in the ask", () => {
    expect(attentionAsk("Only when Flux is behind.")).toBe(
      `${ATTENTION_ASK} When it needs attention: Only when Flux is behind.\n\nWhen it does not, reply with the word ok.`,
    );
    const messages = attentionMessages(
      packet("Only when Flux is behind."),
      context(),
      chars,
    )!;
    expect(messages[1]!.content).toEndWith(
      attentionAsk("Only when Flux is behind."),
    );
    expect(attentionSystem("x")).toContain("needs_attention");
  });

  test("carries the step's own rounds after the ask", () => {
    const step: ChatMessageIn[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "needs_attention", arguments: "{}" }],
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
  const call = { id: "c1", name: "needs_attention", arguments: "{}" };
  const text = (content: string) => ({ calls: [], content });
  test("after a refused reason, with a round left", () => {
    expect(ATTENTION_ROUNDS).toBe(2);
    const refused = { calls: [call], content: "" };
    expect(asksAgain(1, refused, false)).toBeTrue();
    expect(asksAgain(1, refused, true)).toBeFalse();
    expect(asksAgain(2, refused, false)).toBeFalse();
  });

  test("never after ok, whatever its case and trailing punctuation", () => {
    for (const ok of ["ok", "OK.", "Ok", " ok! ", "ok..."]) {
      expect(isOk(ok)).toBeTrue();
      expect(asksAgain(1, text(ok), false)).toBeFalse();
    }
    expect(isOk("okay")).toBeFalse();
    expect(isOk("ok, but flux is behind")).toBeFalse();
  });

  test("after any other text, the tool's name written out included", () => {
    const named = text(
      "needs_attention: Payments service is unhealthy, 0 of 3 pods Ready",
    );
    expect(asksAgain(1, named, false)).toBeTrue();
    expect(asksAgain(1, text(""), false)).toBeTrue();
    expect(asksAgain(2, named, false)).toBeFalse();
  });

  test("with the ask again as the request's last message", () => {
    const messages = attentionMessages(
      packet(),
      { ...context(), again: true },
      chars,
    )!;
    expect(messages.at(-1)).toEqual({ role: "user", content: ATTENTION_AGAIN });
    expect(ATTENTION_AGAIN).toBe(
      "Reply by calling needs_attention with a one-line reason, or with the word ok.",
    );
    expect(attentionMessages(packet(), context(), chars)!.at(-1)?.role).toBe(
      "user",
    );
    expect(attentionMessages(packet(), context(), chars)).toHaveLength(2);
  });
});
