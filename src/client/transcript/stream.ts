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

// thinking is timed from the first token until the text starts
function thinking(message: Message, reasoning: string, content: string) {
  return {
    thinkStart:
      reasoning !== "" && content === ""
        ? message.createdAt + (message.ttftMs ?? 0)
        : null,
    thinkEnd: null,
    thinkMs: message.thinkingMs,
  };
}

export function liveOf(message: Message): Live {
  return {
    content: message.content,
    reasoning: message.reasoning,
    html: message.html,
    htmlAt: message.content.length,
    ...thinking(message, message.reasoning, message.content),
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
    ...thinking(message, snapshot.reasoning, snapshot.content),
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

// A reply streams without a slot until its first call or its end, and
// the words a model says before calling a tool arrive first: shown as
// the answer, they would jump into the fold a moment later. While the
// text is short it is drawn where a work round's words go, paragraphs
// and lists included, since some models narrate before a call in
// several; a longer text is the answer.
export const LEAD_CHARS = 1000;

export function leadIn(content: string): boolean {
  return content.length <= LEAD_CHARS;
}

// the fold's time, drawn after its fixed word; null before the clock
// starts
export function thinkTime(
  live: Live,
  done: boolean,
  now: number,
): string | null {
  if (done && live.thinkMs !== null) return secs(live.thinkMs);
  if (live.thinkStart === null) return null;
  return secs((live.thinkEnd ?? now) - live.thinkStart);
}

// the live clock in whole seconds: a decimal ticking ten times a
// second is noise
export function clock(ms: number): string {
  if (ms >= 60_000) return secs(ms);
  return `${Math.floor(ms / 1000)} s`;
}
