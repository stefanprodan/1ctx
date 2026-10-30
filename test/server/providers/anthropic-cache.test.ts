// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The anthropic wire's cache marks by the request's cache life: five
// minutes everywhere for a short one, an hour everywhere for a long
// one, and on a channel an hour on the system and the stream mark with
// the tail at five minutes, a shorter mark never before a longer one.

import { describe, expect, test } from "bun:test";
import {
  buildAnthropicChatBody as buildChatBody,
  type ChatMessageIn,
  type ChatRequest,
  requestText,
} from "../../../src/server/providers/index.ts";
import { marksOf, stripMarks } from "../../helpers/cache-marks.ts";

const FIVE = { type: "ephemeral" };
const HOUR = { type: "ephemeral", ttl: "1h" };

const request = (
  messages: ChatMessageIn[],
  cacheLife?: ChatRequest["cacheLife"],
): ChatRequest => ({
  model: "claude-haiku-5-5",
  thinking: false,
  messages: [{ role: "system", content: "the head" }, ...messages],
  ...(cacheLife === undefined ? {} : { cacheLife }),
});

const chat: ChatMessageIn[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "second" },
];

// a channel request: a post, the agent's own traced answer, another
// agent's answer at the stream's end, then the local line and the
// question, which merge into the stream's last user turn
const channel = (end: number | null): ChatMessageIn[] => {
  const stream: ChatMessageIn[] = [
    { role: "user", content: "a post" },
    { role: "assistant", content: "own answer" },
    { role: "user", content: "[reviewer] their answer" },
  ];
  if (end !== null) stream[end] = { ...stream[end]!, streamMark: true };
  return [
    ...stream,
    { role: "user", content: "You talk to @casey" },
    { role: "user", content: "the question" },
  ];
};

describe("the anthropic cache marks", () => {
  test("a short life marks five minutes, as with none", () => {
    for (const life of ["short", undefined] as const) {
      const body = buildChatBody(request(chat, life));
      expect(marksOf(body)).toEqual([
        { at: "system", mark: FIVE },
        { at: "answer", mark: FIVE },
        { at: "second", mark: FIVE },
      ]);
      expect(JSON.stringify(body)).not.toContain("ttl");
    }
  });

  test("a short life ignores a stream flag", () => {
    const body = buildChatBody(request(channel(2), "short"));
    expect(JSON.stringify(body)).not.toContain("ttl");
    expect(marksOf(body)).toHaveLength(3);
  });

  test("a long life marks every mark an hour", () => {
    expect(marksOf(buildChatBody(request(chat, "long")))).toEqual([
      { at: "system", mark: HOUR },
      { at: "answer", mark: HOUR },
      { at: "second", mark: HOUR },
    ]);
  });

  test("a channel marks its stream an hour and promotes a tail mark before it", () => {
    const body = buildChatBody(request(channel(2), "channel"));
    // the stream's end merged with the local line and the question
    expect(
      (body.messages as { content: unknown[] }[]).map((t) => t.content.length),
    ).toEqual([1, 1, 3]);
    expect(marksOf(body)).toEqual([
      { at: "system", mark: HOUR },
      // the tail mark of the own answer sits before the stream mark
      { at: "own answer", mark: HOUR },
      { at: "[reviewer] their answer", mark: HOUR },
      { at: "the question", mark: FIVE },
    ]);
  });

  test("a stream mark on a tail block keeps the hour, once", () => {
    const messages: ChatMessageIn[] = [
      { role: "user", content: "a post" },
      { role: "assistant", content: "own answer", streamMark: true },
      { role: "user", content: "the question" },
    ];
    expect(marksOf(buildChatBody(request(messages, "channel")))).toEqual([
      { at: "system", mark: HOUR },
      { at: "own answer", mark: HOUR },
      { at: "the question", mark: FIVE },
    ]);
  });

  test("a second stream mark takes the earlier tail mark's place", () => {
    const messages = channel(2);
    messages[0] = { ...messages[0]!, streamMark: true };
    expect(marksOf(buildChatBody(request(messages, "channel")))).toEqual([
      { at: "system", mark: HOUR },
      { at: "a post", mark: HOUR },
      { at: "[reviewer] their answer", mark: HOUR },
      { at: "the question", mark: FIVE },
    ]);
    // a chat ignores both and keeps its two tail marks
    expect(marksOf(buildChatBody(request(messages, "long")))).toHaveLength(3);
  });

  test("an empty stream leaves the system mark the only hour", () => {
    expect(marksOf(buildChatBody(request(channel(null), "channel")))).toEqual([
      { at: "system", mark: HOUR },
      { at: "own answer", mark: FIVE },
      { at: "the question", mark: FIVE },
    ]);
  });

  test("the stream mark skips a block a mark cannot sit on", () => {
    const messages: ChatMessageIn[] = [
      { role: "user", content: "a post" },
      {
        role: "assistant",
        content: "",
        reasoningDetails: [
          { type: "thinking", thinking: "hm", signature: "sig" },
        ],
        streamMark: true,
      },
      { role: "user", content: "the question" },
      { role: "assistant", content: "x" },
      { role: "user", content: "y" },
    ];
    const marks = marksOf(buildChatBody(request(messages, "channel")));
    expect(marks[1]).toEqual({ at: "a post", mark: HOUR });
  });

  test("never more than four marks, never five minutes before an hour", () => {
    const shapes: ChatMessageIn[][] = [
      chat,
      channel(0),
      channel(1),
      channel(2),
      channel(null),
      [{ role: "user", content: "only", streamMark: true }],
      channel(1).map((m, i) => (i === 0 ? { ...m, streamMark: true } : m)),
    ];
    for (const messages of shapes) {
      for (const life of ["short", "long", "channel"] as const) {
        const marks = marksOf(buildChatBody(request(messages, life)));
        expect(marks.length).toBeLessThanOrEqual(4);
        const lastHour = marks.findLastIndex((m) => m.mark.ttl === "1h");
        expect(marks.slice(0, lastHour + 1).every((m) => m.mark.ttl)).toBe(
          true,
        );
      }
    }
  });

  test("the marks never change the bytes they sit on", () => {
    const short = buildChatBody(request(channel(2), "short"));
    const hour = buildChatBody(request(channel(2), "channel"));
    expect(stripMarks(hour)).toEqual(stripMarks(short));
  });

  test("the stream flag is never counted as another wire's field", () => {
    for (const wire of ["openai-compatible", "openrouter", "azure"] as const) {
      expect(requestText(wire, request(channel(2), "channel"))).not.toContain(
        "streamMark",
      );
    }
  });
});
