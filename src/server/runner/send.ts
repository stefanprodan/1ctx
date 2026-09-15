// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One send in flight: its current round (null while a round's tools
// run), its stream sequence, its budget across rounds, and the one
// terminal transition. A send ends for one cause, whoever names it
// first: terminate() is a compare-and-set, and the winner is the only
// caller of finalizeSend. The lock is held until both the provider
// iteration and the round's tools have let go, which drained says.

import type { LiveSend } from "../../shared/contracts/session.ts";
import type { SendCause, SendKind } from "../../shared/words.ts";
import type { ReasoningDetail, ToolCall, Usage } from "../providers/index.ts";
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
  // the tool calls the provider assembled this round, once the stream
  // ends normally; the loop reads them after the round
  calls: ToolCall[];
  // set to "work" at the first tool call delta, in its own transaction;
  // the round remembers so markRoundWork runs once
  slotMarked: boolean;
};

// what the send spends across its rounds, weighed before each round's
// calls launch
export type Budget = {
  calls: number;
  toolMs: number;
  resultBytes: number;
};

// the phase of a send: talking to the provider, running a round's
// tools with no row streaming, or ended
export type SendPhase = "provider" | "tools" | "terminal";

export type ActiveSend = {
  id: string;
  sessionId: string;
  projectId: string;
  kind: SendKind;
  policy: SendPolicy;
  firstMessageId: string;
  // the round streaming now, or null while its tools run
  round: RoundState | null;
  roundNo: number;
  phase: SendPhase;
  budget: Budget;
  // the fetch and search counters the built-ins share across parallel
  // calls and rounds
  toolBudget: { fetches: number; searches: number };
  // the last three rounds' call signatures, for the loop check
  signatures: string[];
  // the answer round forbids tools with tool_choice none
  answering: boolean;
  // summary rounds ignore calls and are always the send's last round
  summarizing: boolean;
  // the tokens the last counted round used, prompt plus completion: the
  // room the summary round has to fit in; null when nothing was counted
  used: number | null;
  // the change since the previous non-compact send, fixed for its life
  mcpNote: string;
  // the current round's launched tool rows still streaming, keyed by
  // the call object so duplicate provider call ids remain distinct
  openTools: Map<ToolCall, string>;
  // the allSettled of the current round's calls, assigned in the same
  // turn the calls launch; null between rounds
  tools: Promise<void> | null;
  // the stream sequence, per send, from 1
  seq: number;
  controller: AbortController;
  terminal: SendCause | null;
  // resolved when the stream and the tools have let go and the lock may
  // be released
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
    calls: [],
    slotMarked: false,
  };
}

export function newSend(fields: {
  id: string;
  sessionId: string;
  projectId: string;
  kind?: SendKind;
  summarizing?: boolean;
  used?: number | null;
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
    kind: fields.kind ?? "chat",
    policy: fields.policy,
    firstMessageId: fields.firstMessageId,
    round: newRound(fields.replyId, fields.now),
    roundNo: 1,
    phase: "provider",
    budget: { calls: 0, toolMs: 0, resultBytes: 0 },
    toolBudget: { fetches: 0, searches: 0 },
    signatures: [],
    answering: false,
    summarizing: fields.summarizing ?? false,
    used: fields.used ?? null,
    mcpNote: "",
    openTools: new Map(),
    tools: null,
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
  send.phase = "terminal";
  send.controller.abort();
  return true;
}

// the runner's snapshot of a send in flight: the reply as far as it
// got when a round streams, or the tools variant between rounds, when
// the send is running with nothing streaming
export function live(send: ActiveSend): LiveSend {
  const round = send.round;
  if (round === null) {
    return { phase: "tools", sendId: send.id, seq: send.seq };
  }
  return {
    phase: "reply",
    sendId: send.id,
    messageId: round.messageId,
    seq: send.seq,
    content: round.content,
    reasoning: round.reasoning,
    html: round.html,
    htmlAt: round.htmlAt,
  };
}
