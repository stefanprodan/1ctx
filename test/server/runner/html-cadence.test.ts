// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How often a streaming reply's text is rendered for its watchers: a
// whole block soon after it ends, a long reply no more often than its
// size allows, and a block that never ends once it stalls.

import { expect, test } from "bun:test";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { newRound } from "../../../src/server/runner/send.ts";
import {
  HTML_EVERY_MS,
  HTML_MIN_MS,
  HTML_STALL_MS,
  htmlEvery,
  streamDelta,
} from "../../../src/server/runner/stream.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

test("the render gap grows with the html and stays in its bounds", () => {
  expect(htmlEvery(0)).toBe(HTML_MIN_MS);
  expect(htmlEvery(2_000)).toBe(HTML_MIN_MS);
  const mid = htmlEvery(16_000);
  expect(mid).toBeGreaterThan(HTML_MIN_MS);
  expect(mid).toBeLessThan(HTML_EVERY_MS);
  expect(htmlEvery(16_000)).toBeGreaterThanOrEqual(htmlEvery(8_000));
  expect(htmlEvery(400_000)).toBe(HTML_EVERY_MS);
});

function streaming(html: (md: string) => string) {
  let now = 1_000;
  const frames: SocketEvent[] = [];
  const send = {
    id: "send-1",
    sessionId: "chat-1",
    seq: 0,
    round: newRound("reply-1", now),
  } as unknown as ActiveSend;
  const deps = {
    clock: () => now,
    sessions: { writeReply: () => true },
    render: (md: string) => html(md),
    stream: (_: string, frame: SocketEvent) => frames.push(frame),
  };
  return {
    say(text: string, after: number) {
      now += after;
      streamDelta(deps, send, { kind: "content", text });
    },
    rendered: () =>
      frames.flatMap((f) => (f.type === "html" ? [f.htmlAt] : [])),
  };
}

test("a block renders soon after it ends", () => {
  const reply = streaming((md) => `<p class="md-p">${md}</p>`);
  reply.say("1. **Check** the ", 0);
  reply.say("logs.\n\n", HTML_MIN_MS / 2);
  expect(reply.rendered()).toEqual([]);
  reply.say("Then", HTML_MIN_MS / 2);
  expect(reply.rendered()).toEqual(["1. **Check** the logs.\n\n".length]);
});

test("only whole blocks render, and only when one more ended", () => {
  const sources: string[] = [];
  const reply = streaming((md) => {
    sources.push(md);
    return md;
  });
  reply.say("First.\n\nSecond is still ", HTML_MIN_MS);
  expect(reply.rendered()).toEqual(["First.\n\n".length]);
  expect(sources).toEqual(["First.\n\n"]);
  reply.say("growing", HTML_MIN_MS);
  reply.say(" and growing", HTML_MIN_MS);
  expect(reply.rendered()).toEqual(["First.\n\n".length]);
  reply.say(".\n\n", HTML_MIN_MS);
  const whole = "First.\n\nSecond is still growing and growing.\n\n";
  expect(reply.rendered()).toEqual(["First.\n\n".length, whole.length]);
  expect(sources.at(-1)).toBe(whole);
});

test("a paragraph that never ends renders whole once it stalls", () => {
  const reply = streaming((md) => md);
  reply.say("A long ", 0);
  reply.say("paragraph ", HTML_STALL_MS - HTML_MIN_MS);
  expect(reply.rendered()).toEqual([]);
  reply.say("goes on", HTML_MIN_MS);
  const whole = "A long paragraph goes on";
  expect(reply.rendered()).toEqual([whole.length]);
  reply.say(" and on", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([whole.length]);
  reply.say(".\n\n", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([
    whole.length,
    `${whole} and on.\n\n`.length,
  ]);
});

test("the stall counts from the first text, not the round's start", () => {
  const reply = streaming((md) => md);
  reply.say("The", HTML_STALL_MS * 2);
  expect(reply.rendered()).toEqual([]);
  reply.say(" answer", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([]);
  reply.say(" waits", HTML_STALL_MS);
  expect(reply.rendered()).toEqual(["The answer waits".length]);
});

test("a paragraph waits no longer than the slowest render gap", () => {
  expect(HTML_STALL_MS).toBe(1_000);
});

test("a list renders item by item", () => {
  const reply = streaming((md) => md);
  reply.say("- `x-limit` is the cap\n- `x-rem", HTML_MIN_MS);
  const first = "- `x-limit` is the cap\n".length;
  expect(reply.rendered()).toEqual([first]);
  reply.say("aining` is left\n- `x-re", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([
    first,
    "- `x-limit` is the cap\n- `x-remaining` is left\n".length,
  ]);
});

test("a table renders row by row", () => {
  const reply = streaming((md) => md);
  reply.say("| a | b |\n|---|---|\n| 1 |", HTML_MIN_MS);
  const head = "| a | b |\n|---|---|\n".length;
  expect(reply.rendered()).toEqual([head]);
  reply.say(" 2 |\n| 3", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([head, head + "| 1 | 2 |\n".length]);
});

test("an open code block renders by whole lines", () => {
  const reply = streaming((md) => md);
  reply.say("```sh\nmake\nmake te", HTML_MIN_MS);
  expect(reply.rendered()).toEqual(["```sh\nmake\n".length]);
  reply.say("st\n", HTML_MIN_MS);
  expect(reply.rendered()).toEqual([
    "```sh\nmake\n".length,
    "```sh\nmake\nmake test\n".length,
  ]);
});

test("a long reply renders no more often than before", () => {
  const reply = streaming((md) => "x".repeat(md.length * 100));
  reply.say(`${"a".repeat(5_000)}\n\n`, HTML_EVERY_MS);
  expect(reply.rendered()).toEqual([5_002]);
  reply.say("b\n\n", HTML_EVERY_MS - 1);
  expect(reply.rendered()).toEqual([5_002]);
  reply.say("c", 1);
  expect(reply.rendered()).toEqual([5_002, 5_005]);
});
