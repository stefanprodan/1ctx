// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How often a streaming reply's text is rendered for its watchers: a
// short reply soon, so its tail is never long raw, a long one no more
// often than its size allows.

import { expect, test } from "bun:test";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { newRound } from "../../../src/server/runner/send.ts";
import {
  HTML_EVERY_MS,
  HTML_MIN_MS,
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

test("a short reply's words settle within a tenth of a second", () => {
  const reply = streaming((md) => `<p class="md-p">${md}</p>`);
  reply.say("1. **Check** the ", 0);
  reply.say("logs", HTML_MIN_MS / 2);
  expect(reply.rendered()).toEqual([]);
  reply.say(".", HTML_MIN_MS / 2);
  expect(reply.rendered()).toEqual(["1. **Check** the logs.".length]);
});

test("a long reply renders no more often than before", () => {
  const reply = streaming((md) => "x".repeat(md.length * 100));
  reply.say("a".repeat(5_000), HTML_EVERY_MS);
  expect(reply.rendered()).toEqual([5_000]);
  reply.say("b", HTML_EVERY_MS - 1);
  expect(reply.rendered()).toEqual([5_000]);
  reply.say("c", 1);
  expect(reply.rendered()).toEqual([5_000, 5_002]);
});
