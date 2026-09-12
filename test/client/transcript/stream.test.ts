// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyDelta,
  applyHtml,
  finish,
  type Live,
  liveOf,
  liveOfSnapshot,
  secs,
  tail,
  thinkLabel,
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
  userId: null,
  agentId: "a1",
  content: "",
  reasoning: "",
  html: "",
  status: "streaming",
  error: null,
  finishReason: null,
  model: "model",
  ttftMs: null,
  thinkingMs: null,
  createdAt: 1_000,
  finishedAt: null,
  ...fields,
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
      reasoning: "thought",
      html: "<p>answer</p>",
      ttftMs: 25,
    });
    expect(liveOf(row)).toMatchObject({
      content: "answer",
      reasoning: "thought",
      htmlAt: 6,
      thinkStart: null,
    });

    const snapshot: LiveSend = {
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

  test("finishes from the row while keeping client clocks", () => {
    const before = live({ thinkStart: 1_000, thinkEnd: 4_200 });
    const done = finish(
      before,
      message({
        content: "answer",
        reasoning: "thought",
        html: "<p>answer</p>",
        status: "done",
        thinkingMs: 3_100,
      }),
      5_000,
    );
    expect(done).toMatchObject({
      content: "answer",
      reasoning: "thought",
      htmlAt: 6,
      thinkStart: 1_000,
      thinkEnd: 4_200,
      thinkMs: 3_100,
    });
  });

  test("returns content after the rendered boundary", () => {
    expect(tail(live({ content: "abcdef", htmlAt: 3 }))).toBe("def");
  });
});

describe("thinking labels", () => {
  test("formats each clock state", () => {
    expect(thinkLabel(live(), false, 3_200)).toBe("Thinking");
    expect(thinkLabel(live({ thinkStart: 0 }), false, 3_200)).toBe(
      "Thinking for 3.2 s",
    );
    expect(
      thinkLabel(live({ thinkStart: 0, thinkEnd: 12_000 }), false, 20_000),
    ).toBe("Thought for 12 s");
    expect(thinkLabel(live({ thinkMs: 65_000 }), true, 100_000)).toBe(
      "Thought for 1 min 5 s",
    );
  });

  test("formats seconds and minutes", () => {
    expect(secs(3_240)).toBe("3.2 s");
    expect(secs(12_400)).toBe("12 s");
    expect(secs(65_000)).toBe("1 min 5 s");
  });
});
