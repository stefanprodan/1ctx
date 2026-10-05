// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ephemeral reply stream and crash checkpoint. Durable placement and
// round transitions stay in writer.ts.

import type { LiveRetry } from "../../shared/contracts/session.ts";
import type { SocketEvent, VisualFrame } from "../../shared/socket.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent } from "../providers/index.ts";
import { stableEnd } from "../render/index.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import type { SessionsPort } from "./writer-port.ts";

const WRITE_EVERY_MS = 250;
const WRITE_EVERY_BYTES = 2048;
// how often a reply is looked at for newly whole blocks to render; each
// render goes whole to every watcher, so the gap grows with the html,
// capped at HTML_CHARS_PER_MS and once a second
export const HTML_EVERY_MS = 1000;
export const HTML_MIN_MS = 100;
const HTML_CHARS_PER_MS = 32;
// only whole blocks render, so a paragraph still growing would stay
// raw; past this with no render since the text began it renders whole.
// Raw bold and links read worse than the small jump a cut paragraph
// makes, so it is no longer than the slowest render gap
export const HTML_STALL_MS = HTML_EVERY_MS;

export const htmlEvery = (htmlLength: number): number =>
  Math.min(
    HTML_EVERY_MS,
    Math.max(HTML_MIN_MS, Math.ceil(htmlLength / HTML_CHARS_PER_MS)),
  );

export type StreamDeps = {
  clock: Clock;
  sessions: Pick<SessionsPort, "writeReply">;
  render: (markdown: string, streaming: boolean) => string;
  stream: (sessionId: string, frame: SocketEvent) => void;
};

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

export function streamVisual(
  deps: StreamDeps,
  send: ActiveSend,
  piece: Pick<VisualFrame, "callIndex" | "title" | "html" | "htmlAt">,
): void {
  const round = send.round;
  if (round === null) return;
  const previous = round.drafts.get(piece.callIndex);
  round.drafts.set(piece.callIndex, {
    messageId: round.messageId,
    callIndex: piece.callIndex,
    ...(piece.title === undefined
      ? previous?.title === undefined
        ? {}
        : { title: previous.title }
      : { title: piece.title }),
    html: (previous?.html ?? "") + piece.html,
  });
  deps.stream(send.sessionId, {
    type: "visual",
    sessionId: send.sessionId,
    sendId: send.id,
    messageId: round.messageId,
    seq: ++send.seq,
    ...piece,
  });
}

// held on the round alone, never stored: a watcher joining mid-wait
// reads it from the snapshot
export function streamRetry(
  deps: StreamDeps,
  send: ActiveSend,
  retry: LiveRetry | null,
): void {
  const round = send.round;
  if (round === null) return;
  if (round.retry === null && retry === null) return;
  round.retry = retry === null ? null : { ...retry };
  deps.stream(send.sessionId, {
    type: "retry",
    sessionId: send.sessionId,
    sendId: send.id,
    seq: ++send.seq,
    retry: round.retry,
  });
}

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
    // the stall counts from the first text, so a slow first token never
    // renders a reply's first word alone
    if (contentAt === 0) round.lastHtmlAt = now;
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
    now - round.htmlTriedAt >= htmlEvery(round.html.length)
  ) {
    round.htmlTriedAt = now;
    const stable = stableEnd(round.content);
    const end =
      stable > round.htmlAt
        ? stable
        : now - round.lastHtmlAt >= HTML_STALL_MS
          ? round.content.length
          : null;
    if (end === null) return;
    round.lastHtmlAt = now;
    round.htmlAt = end;
    round.html = deps.render(round.content.slice(0, end), true);
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
