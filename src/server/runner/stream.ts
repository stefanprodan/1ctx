// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ephemeral reply stream and crash checkpoint. Durable placement and
// round transitions stay in writer.ts.

import type { SocketEvent } from "../../shared/socket.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent } from "../providers/index.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import type { SessionsPort } from "./writer-port.ts";

export const WRITE_EVERY_MS = 250;
export const WRITE_EVERY_BYTES = 2048;
export const HTML_EVERY_MS = 1000;

export type StreamDeps = {
  clock: Clock;
  sessions: Pick<SessionsPort, "writeReply">;
  render: (markdown: string, streaming: boolean) => string;
  stream: (sessionId: string, frame: SocketEvent) => void;
};

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

function checkpoint(deps: StreamDeps, round: RoundState, now: number): void {
  const size = bytes(round.content) + bytes(round.reasoning);
  if (
    now - round.lastWriteAt < WRITE_EVERY_MS &&
    size - round.lastWriteSize < WRITE_EVERY_BYTES
  ) {
    return;
  }
  if (deps.sessions.writeReply(round.messageId, round)) {
    round.lastWriteAt = now;
    round.lastWriteSize = size;
  }
}

export function streamDelta(
  deps: StreamDeps,
  send: ActiveSend,
  event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
): void {
  const round = send.round;
  if (round === null) return;
  const now = deps.clock();
  const contentAt = round.content.length;
  const reasoningAt = round.reasoning.length;
  if (round.ttftMs === null) round.ttftMs = now - round.startedAt;
  if (event.kind === "content") {
    if (round.reasoningStartedAt !== null && round.thinkingMs === null) {
      round.thinkingMs = now - round.reasoningStartedAt;
    }
    round.content += event.text;
  } else {
    if (round.reasoningStartedAt === null) round.reasoningStartedAt = now;
    round.reasoning += event.text;
  }
  send.seq++;
  deps.stream(send.sessionId, {
    type: "delta",
    sessionId: send.sessionId,
    sendId: send.id,
    messageId: round.messageId,
    seq: send.seq,
    ...(event.kind === "content" ? { content: event.text } : {}),
    contentAt,
    ...(event.kind === "reasoning" ? { reasoning: event.text } : {}),
    reasoningAt,
  });
  checkpoint(deps, round, now);
  if (
    event.kind === "content" &&
    round.content.length > round.htmlAt &&
    now - round.lastHtmlAt >= HTML_EVERY_MS
  ) {
    round.lastHtmlAt = now;
    round.htmlAt = round.content.length;
    round.html = deps.render(round.content, true);
    send.seq++;
    deps.stream(send.sessionId, {
      type: "html",
      sessionId: send.sessionId,
      sendId: send.id,
      messageId: round.messageId,
      seq: send.seq,
      html: round.html,
      htmlAt: round.htmlAt,
    });
  }
}
