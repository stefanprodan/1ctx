// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyDelta,
  applyHtml,
  LEAD_CHARS,
  type Live,
  leadIn,
  liveOf,
  liveOfSnapshot,
  secs,
  tail,
  thinkLabel,
  thinkParts,
} from "../../../src/client/transcript/stream.ts";
import type {
  LiveSend,
  Message,
} from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

type DeltaFrame = Extract<SocketEvent, { type: "delta" }>;
type HtmlFrame = Extract<SocketEvent, { type: "html" }>;

const message = (fields: Partial<Message> = {}): Message => ({
  id: "m1",
  sessionId: "s1",
  seq: 2,
  kind: "reply",
  sendId: "send1",
  round: 1,
  slot: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  userId: null,
  agentId: "a1",
  content: "",
  uploads: null,
  files: null,
  reasoning: "",
  html: "",
  status: "streaming",
  error: null,
  finishReason: null,
  model: "model",
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
  createdAt: 1_000,
  finishedAt: null,
  ...fields,
  resultBytes: fields.resultBytes ?? null,
  promptTokens: fields.promptTokens ?? null,
});

const live = (fields: Partial<Live> = {}): Live => ({
  content: "",
  reasoning: "",
  html: "",
  htmlAt: 0,
  thinkStart: null,
  thinkEnd: null,
  thinkMs: null,
  ...fields,
});

const delta = (fields: Partial<DeltaFrame>): DeltaFrame => ({
  type: "delta",
  sessionId: "s1",
  sendId: "send1",
  messageId: "m1",
  seq: 1,
  contentAt: 0,
  reasoningAt: 0,
  ...fields,
});

const html = (fields: Partial<HtmlFrame>): HtmlFrame => ({
  type: "html",
  sessionId: "s1",
  sendId: "send1",
  messageId: "m1",
  seq: 1,
  html: '<p class="md-p">abc</p>',
  htmlAt: 3,
  ...fields,
});

describe("live transcript buffers", () => {
  test("starts from a message or runner snapshot", () => {
    const row = message({
      content: "answer",
      reasoning: "thinking",
      html: "<p>answer</p>",
      ttftMs: 25,
    });
    expect(liveOf(row)).toMatchObject({
      content: "answer",
      reasoning: "thinking",
      htmlAt: 6,
      thinkStart: null,
    });

    const snapshot: Extract<LiveSend, { phase: "reply" }> = {
      phase: "reply",
      sendId: "send1",
      messageId: "m1",
      seq: 4,
      content: "",
      reasoning: "new thought",
      html: "",
      htmlAt: 0,
    };
    expect(liveOfSnapshot(snapshot, row)).toMatchObject({
      content: "",
      reasoning: "new thought",
      thinkStart: 1_025,
    });
  });

  test("continues at the buffer boundary", () => {
    const result = applyDelta(
      live({ content: "abc" }),
      delta({ content: "def", contentAt: 3 }),
      100,
    );
    expect(result.gap).toBeFalse();
    expect(result.live.content).toBe("abcdef");
  });

  test("trims a piece overlapping the buffer", () => {
    const result = applyDelta(
      live({ content: "abc" }),
      delta({ content: "bcde", contentAt: 1 }),
      100,
    );
    expect(result.gap).toBeFalse();
    expect(result.live.content).toBe("abcde");
  });

  test("reports a piece ahead of the buffer as a gap", () => {
    const before = live({ content: "abc" });
    const result = applyDelta(
      before,
      delta({ content: "ef", contentAt: 4 }),
      100,
    );
    expect(result).toEqual({ live: before, gap: true });
  });

  test("sets thinking clocks between reasoning and content", () => {
    const reasoning = applyDelta(
      live(),
      delta({ reasoning: "hmm", reasoningAt: 0 }),
      1_000,
    ).live;
    expect(reasoning.thinkStart).toBe(1_000);
    expect(reasoning.thinkEnd).toBeNull();

    const content = applyDelta(
      reasoning,
      delta({ content: "yes", contentAt: 0 }),
      4_200,
    ).live;
    expect(content.thinkStart).toBe(1_000);
    expect(content.thinkEnd).toBe(4_200);
  });

  test("does not move rendered html past content or backwards", () => {
    const before = live({ content: "abcdef", html: "old", htmlAt: 3 });
    expect(applyHtml(before, html({ htmlAt: 7 }))).toBe(before);
    expect(applyHtml(before, html({ htmlAt: 2 }))).toBe(before);
    expect(applyHtml(before, html({ html: "new", htmlAt: 6 }))).toEqual({
      ...before,
      html: "new",
      htmlAt: 6,
    });
  });

  test("returns content after the rendered boundary", () => {
    expect(tail(live({ content: "abcdef", htmlAt: 3 }))).toBe("def");
  });
});

describe("unslotted lead-in", () => {
  test("keeps one short paragraph where a work round's words go", () => {
    expect(leadIn("")).toBe(true);
    expect(
      leadIn(
        "Round 1 data received. Now Round 2: fetching three articles.\n\n",
      ),
    ).toBe(true);
    expect(leadIn("x".repeat(LEAD_CHARS))).toBe(true);
  });

  test("gives a second paragraph or a long one to the answer", () => {
    expect(leadIn("All data collected.\n\n## Snapshot")).toBe(false);
    expect(leadIn("All data collected.\n \n---")).toBe(false);
    expect(leadIn("x".repeat(LEAD_CHARS + 1))).toBe(false);
  });
});

describe("thinking labels", () => {
  test("formats each clock state", () => {
    expect(thinkLabel(live(), false, 3_200)).toBe("thinking");
    expect(thinkLabel(live(), true, 3_200)).toBe("thinking");
    expect(thinkLabel(live({ thinkStart: 0 }), false, 3_200)).toBe(
      "thinking for 3.2 s",
    );
    expect(
      thinkLabel(live({ thinkStart: 0, thinkEnd: 12_000 }), false, 20_000),
    ).toBe("thinking for 12 s");
    expect(thinkLabel(live({ thinkMs: 65_000 }), true, 100_000)).toBe(
      "thinking for 1 min 5 s",
    );
  });

  test("returns each clock state as separate parts", () => {
    expect(thinkParts(live(), false, 3_200)).toEqual({
      word: "thinking",
      time: null,
    });
    expect(thinkParts(live({ thinkStart: 0 }), false, 3_200)).toEqual({
      word: "thinking",
      time: "3.2 s",
    });
    expect(
      thinkParts(live({ thinkStart: 0, thinkEnd: 12_000 }), false, 20_000),
    ).toEqual({ word: "thinking", time: "12 s" });
    expect(thinkParts(live({ thinkMs: 65_000 }), true, 100_000)).toEqual({
      word: "thinking",
      time: "1 min 5 s",
    });
    expect(thinkParts(live(), true, 3_200)).toEqual({
      word: "thinking",
      time: null,
    });
  });

  test("formats seconds and minutes", () => {
    expect(secs(3_240)).toBe("3.2 s");
    expect(secs(12_400)).toBe("12 s");
    expect(secs(65_000)).toBe("1 min 5 s");
  });
});
