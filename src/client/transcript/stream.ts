// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LiveSend, Message } from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";

export type Live = {
  content: string;
  reasoning: string;
  html: string;
  htmlAt: number;
  thinkStart: number | null;
  thinkEnd: number | null;
  thinkMs: number | null;
};

type DeltaFrame = Extract<SocketEvent, { type: "delta" }>;
type HtmlFrame = Extract<SocketEvent, { type: "html" }>;

export const secs = (ms: number): string =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export function liveOf(message: Message): Live {
  return {
    content: message.content,
    reasoning: message.reasoning,
    html: message.html,
    htmlAt: message.content.length,
    thinkStart:
      message.reasoning !== "" && message.content === ""
        ? message.createdAt + (message.ttftMs ?? 0)
        : null,
    thinkEnd: null,
    thinkMs: message.thinkingMs,
  };
}

// only a streaming reply seeds a live buffer; the "tools" phase has no
// row and is handled by the caller without a live entry
export function liveOfSnapshot(
  snapshot: Extract<LiveSend, { phase: "reply" }>,
  message: Message,
): Live {
  return {
    content: snapshot.content,
    reasoning: snapshot.reasoning,
    html: snapshot.html,
    htmlAt: snapshot.htmlAt,
    thinkStart:
      snapshot.reasoning !== "" && snapshot.content === ""
        ? message.createdAt + (message.ttftMs ?? 0)
        : null,
    thinkEnd: null,
    thinkMs: message.thinkingMs,
  };
}

function past(text: string, at: number, have: number): string | null {
  if (at > have) return null;
  return text.slice(have - at);
}

export function applyDelta(
  live: Live,
  frame: DeltaFrame,
  now: number,
): { live: Live; gap: boolean } {
  let reasoning = live.reasoning;
  let content = live.content;
  let { thinkStart, thinkEnd } = live;

  if (frame.reasoning !== undefined) {
    const addition = past(frame.reasoning, frame.reasoningAt, reasoning.length);
    if (addition === null) return { live, gap: true };
    if (addition !== "" && reasoning === "") thinkStart = now;
    reasoning += addition;
  }

  if (frame.content !== undefined) {
    const addition = past(frame.content, frame.contentAt, content.length);
    if (addition === null) return { live, gap: true };
    if (addition !== "" && content === "" && thinkStart !== null) {
      thinkEnd ??= now;
    }
    content += addition;
  }

  return {
    live: { ...live, content, reasoning, thinkStart, thinkEnd },
    gap: false,
  };
}

export function applyHtml(live: Live, frame: HtmlFrame): Live {
  if (frame.htmlAt > live.content.length || frame.htmlAt < live.htmlAt) {
    return live;
  }
  return { ...live, html: frame.html, htmlAt: frame.htmlAt };
}

export const tail = (live: Live): string => live.content.slice(live.htmlAt);

export function thinkLabel(live: Live, done: boolean, now: number): string {
  if (done && live.thinkMs !== null) {
    return `Thought for ${secs(live.thinkMs)}`;
  }
  if (live.thinkStart === null) return "Thinking";
  const end = live.thinkEnd ?? now;
  const word = done || live.thinkEnd !== null ? "Thought" : "Thinking";
  return `${word} for ${secs(end - live.thinkStart)}`;
}
