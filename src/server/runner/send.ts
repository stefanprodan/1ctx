// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One send in flight: its current round (null while a round's tools
// run), its stream sequence, its budget across rounds, and the one
// terminal transition. A send ends for one cause, whoever names it
// first: terminate() is a compare-and-set, and the winner is the only
// caller of finalizeSend. The lock is held until both the provider
// iteration and the round's tools have let go, which drained says.

import type { LiveSend, VisualDraft } from "../../shared/contracts/session.ts";
import type { SendCause, SendKind } from "../../shared/words.ts";
import type { ReasoningDetail, ToolCall, Usage } from "../providers/index.ts";
import type { KeepPort, SendPolicy, ToolBudget } from "./policy.ts";

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
  // from a router's frames, null where they did not say: the upstream,
  // the model that answered when it is not the one asked for, and the
  // upstream's stop reason when it differs from finishReason
  upstream: string | null;
  servedModel: string | null;
  nativeFinish: string | null;
  usage: Usage | null;
  tokens: number;
  // what the tool-work budget adds: tokens with cached reads weighed
  spent: number;
  // the tool calls the provider assembled this round, once the stream
  // ends normally; the loop reads them after the round
  calls: ToolCall[];
  drafts: Map<number, VisualDraft>;
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
  tokens: number;
};

export type CapReason =
  | "tool_limit"
  | "token_limit"
  | "context_limit"
  | "tool_loop";

// the phase of a send: talking to the provider, running a round's
// tools with no row streaming, or ended
export type SendPhase = "provider" | "tools" | "memory" | "terminal";

export type SendOp = "message" | "regenerate" | "compact" | "run";

export type ActiveSend = {
  id: string;
  sessionId: string;
  projectId: string;
  kind: SendKind;
  op: SendOp;
  startedAt: number;
  policy: SendPolicy;
  firstMessageId: string;
  // the round streaming now, or null while its tools run
  round: RoundState | null;
  roundNo: number;
  phase: SendPhase;
  budget: Budget;
  promptTokens: number;
  completionTokens: number;
  // the counters the built-ins share across parallel
  // calls and rounds
  toolBudget: ToolBudget;
  // set at the start of a send that offers bash
  keep: KeepPort | null;
  // the last three rounds' call signatures, for the loop check
  signatures: string[];
  // the cap that forced the answer round, which asks for the answer in words
  answering: CapReason | null;
  // a call in the answer round is asked again: a local server first
  // with the same request, which its cached prefix answers in seconds,
  // then every wire with no schemas, which leaves nothing to call
  // the loop check warned once: the next trip asks for the answer
  loopWarned: boolean;
  repeated: boolean;
  bare: boolean;
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
  // Even aborted calls must release their mounts before the send unlocks.
  tools: Promise<void> | null;
  // the stream sequence, per send, from 1
  seq: number;
  controller: AbortController;
  // Stop and shutdown reach the ending even after another cause won.
  ending: AbortController;
  cause: SendCause | null;
  error: string | null;
  memoryRound: number | null;
  memoryError: string | null;
  memorySkipped: number | null;
  memoryStopped: boolean;
  terminal: SendCause | null;
  // every caller of terminate observes the ending run by run().
  ended: Promise<boolean>;
  end: (finalized: boolean) => void;
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
    upstream: null,
    servedModel: null,
    nativeFinish: null,
    usage: null,
    tokens: 0,
    spent: 0,
    calls: [],
    drafts: new Map(),
    slotMarked: false,
  };
}

export function newSend(fields: {
  id: string;
  sessionId: string;
  projectId: string;
  kind?: SendKind;
  op: SendOp;
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
  let end = (_finalized: boolean) => {};
  const ended = new Promise<boolean>((resolve) => {
    end = resolve;
  });
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    projectId: fields.projectId,
    kind: fields.kind ?? "chat",
    op: fields.op,
    startedAt: fields.now,
    policy: fields.policy,
    firstMessageId: fields.firstMessageId,
    round: newRound(fields.replyId, fields.now),
    roundNo: 1,
    phase: "provider",
    budget: { calls: 0, toolMs: 0, resultBytes: 0, tokens: 0 },
    promptTokens: 0,
    completionTokens: 0,
    toolBudget: {
      fetches: 0,
      searches: 0,
      visualBytes: 0,
      visuals: 0,
      bashCalls: 0,
    },
    keep: null,
    signatures: [],
    answering: null,
    loopWarned: false,
    repeated: false,
    bare: false,
    summarizing: fields.summarizing ?? false,
    used: fields.used ?? null,
    mcpNote: "",
    openTools: new Map(),
    tools: null,
    seq: 0,
    controller: new AbortController(),
    ending: new AbortController(),
    cause: null,
    error: null,
    memoryRound: null,
    memoryError: null,
    memorySkipped: null,
    memoryStopped: false,
    terminal: null,
    ended,
    end,
    drained,
    letGo,
  };
}

// the first caller wins; a later one gets false and does nothing
export function claim(
  send: ActiveSend,
  cause: SendCause,
  error: string | null = null,
): boolean {
  if (send.cause !== null) return false;
  send.cause = cause;
  send.error = error;
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
    ...(round.drafts.size > 0
      ? { drafts: [...round.drafts.values()].map((draft) => ({ ...draft })) }
      : {}),
  };
}
