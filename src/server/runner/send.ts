// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One send in flight: its round, its stream sequence, and the one
// terminal transition. A send ends for one cause, whoever names it
// first: terminate() is a compare-and-set, and the winner is the only
// caller of finalizeSend. The lock is held until the stream has let
// go, which the drained promise says.

import type { LiveSend } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { ReasoningDetail, Usage } from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";

export type RoundState = {
  messageId: string;
  startedAt: number;
  content: string;
  reasoning: string;
  reasoningDetails: ReasoningDetail[];
  ttftMs: number | null;
  reasoningStartedAt: number | null;
  thinkingMs: number | null;
  // the checkpoint cadence
  lastWriteAt: number;
  lastWriteSize: number;
  // the render cadence, and the last render sent
  lastHtmlAt: number;
  html: string;
  htmlAt: number;
  finishReason: string | null;
  usage: Usage | null;
};

export type ActiveSend = {
  id: string;
  sessionId: string;
  projectId: string;
  policy: SendPolicy;
  firstMessageId: string;
  round: RoundState;
  roundNo: number;
  // the stream sequence, per send, from 1
  seq: number;
  controller: AbortController;
  terminal: SendCause | null;
  // resolved when the stream has let go and the lock may be released
  drained: Promise<void>;
  letGo: () => void;
};

export function newRound(messageId: string, now: number): RoundState {
  return {
    messageId,
    startedAt: now,
    content: "",
    reasoning: "",
    reasoningDetails: [],
    ttftMs: null,
    reasoningStartedAt: null,
    thinkingMs: null,
    lastWriteAt: now,
    lastWriteSize: 0,
    lastHtmlAt: now,
    html: "",
    htmlAt: 0,
    finishReason: null,
    usage: null,
  };
}

export function newSend(fields: {
  id: string;
  sessionId: string;
  projectId: string;
  policy: SendPolicy;
  firstMessageId: string;
  replyId: string;
  now: number;
}): ActiveSend {
  let letGo = () => {};
  const drained = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    projectId: fields.projectId,
    policy: fields.policy,
    firstMessageId: fields.firstMessageId,
    round: newRound(fields.replyId, fields.now),
    roundNo: 1,
    seq: 0,
    controller: new AbortController(),
    terminal: null,
    drained,
    letGo,
  };
}

// the first caller wins; a later one gets false and does nothing
export function claim(send: ActiveSend, cause: SendCause): boolean {
  if (send.terminal !== null) return false;
  send.terminal = cause;
  send.controller.abort();
  return true;
}

export function live(send: ActiveSend): LiveSend {
  return {
    sendId: send.id,
    messageId: send.round.messageId,
    seq: send.seq,
    content: send.round.content,
    reasoning: send.round.reasoning,
    html: send.round.html,
    htmlAt: send.round.htmlAt,
  };
}
