// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Row writes the writer's transactions share; each runs inside its caller's.

import type { Message } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { SessionStatus } from "../../shared/words.ts";
import type { UsageFields } from "../usage/index.ts";
import {
  type ActiveSend,
  afterRun,
  type RoundState,
  unmarkAnswer,
} from "./send.ts";
import type { SessionsPort } from "./writer-port.ts";

// the text a call cut before it ran gets, as its content
export const NOT_RUN = "not run: the tool budget was spent";
export const NOT_RUN_LOOP = "not run: the same calls came three times in a row";
// the loop check's first trip: the calls are refused and the loop goes on
export const NOT_RUN_REPEAT =
  "not run: the same calls as your previous two rounds, and their results are above. Use them, call something else, or answer.";
export const OVER_ROUND = "not run: too many calls in one round";

export function notRun(reason: string): string {
  return reason === "tool_loop" ? NOT_RUN_LOOP : NOT_RUN;
}
// the text a call still running when the send ended gets
export const CUT_SHORT = "stopped before it finished";

export type ReplyRowsDeps = {
  sessions: SessionsPort;
  usage: { record(fields: UsageFields): unknown };
  render: (markdown: string) => string;
};

export function finishReplyRow(
  deps: ReplyRowsDeps,
  round: RoundState,
  status: Exclude<SessionStatus, "running">,
  error: string | null,
  slot: "work" | "answer" | null,
  toolCalls: ToolCall[] | null,
  now: number,
  finishReason = round.finishReason,
): Message | null {
  const thinkingMs =
    round.thinkingMs ??
    (round.reasoningStartedAt === null ? null : now - round.reasoningStartedAt);
  return deps.sessions.finishReply(round.messageId, {
    content: round.content,
    reasoning: round.reasoning,
    reasoningDetails: round.reasoningDetails,
    html: deps.render(round.content),
    status,
    error,
    finishReason,
    slot,
    toolCalls,
    ttftMs: round.ttftMs,
    thinkingMs,
    upstream: round.upstream,
    servedModel: round.servedModel,
    nativeFinish: round.nativeFinish,
    finishedAt: now,
  });
}

export function recordUsage(
  deps: ReplyRowsDeps,
  send: ActiveSend,
  round: RoundState,
  now: number,
): void {
  const usage = round.usage;
  if (usage === null) return;
  deps.usage.record({
    sendId: send.id,
    sessionId: send.sessionId,
    projectId: send.projectId,
    userId: send.policy.userId,
    agentId: send.policy.agentId,
    providerId: send.policy.providerId,
    model: send.policy.model,
    round: send.roundNo,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
    cost: usage.cost,
    contextLength: send.policy.contextLength,
    upstream: round.upstream,
    servedModel: round.servedModel,
    now,
  });
}

export function newToolRows(
  sessions: SessionsPort,
  send: ActiveSend,
  calls: ToolCall[],
  now: number,
  toolNames: string[] = calls.map((call) => call.name),
): Message[] {
  return sessions.addToolRows(
    calls.map((call, index) => ({
      sessionId: send.sessionId,
      sendId: send.id,
      round: send.roundNo,
      toolCallId: call.id,
      toolName: toolNames[index] ?? call.name,
      now,
    })),
  );
}

// a round cut before its calls ran: the reply done as work, each call
// a tool row stopped with the given text, the round's usage
export function cutCalls(
  deps: ReplyRowsDeps,
  send: ActiveSend,
  round: RoundState,
  calls: ToolCall[],
  finishReason: string,
  content: string,
  now: number,
): Message[] {
  const reply = finishReplyRow(
    deps,
    round,
    "done",
    null,
    "work",
    calls,
    now,
    finishReason,
  );
  const stopped = newToolRows(deps.sessions, send, calls, now).map(
    (row) =>
      deps.sessions.finishTool(row.id, {
        content,
        status: "stopped",
        error: null,
        finishedAt: now,
      })!,
  );
  recordUsage(deps, send, round, now);
  return reply ? [reply, ...stopped] : stopped;
}

// a guard means a late tool that already wrote returns null
export function stopOpenTools(
  sessions: SessionsPort,
  send: ActiveSend,
  now: number,
): Message[] {
  const stopped: Message[] = [];
  for (const rowId of send.openTools.values()) {
    const row = sessions.finishTool(rowId, {
      content: CUT_SHORT,
      status: "stopped",
      error: null,
      finishedAt: now,
    });
    if (row !== null) stopped.push(row);
  }
  return stopped;
}

// the round's reply as it ends and its usage; a null slot becomes
// answer. Null when no round is streaming
export function finalizeRound(
  deps: ReplyRowsDeps,
  send: ActiveSend,
  status: Exclude<SessionStatus, "running">,
  error: string | null,
  now: number,
): Message | null {
  const round = send.round;
  if (round === null) return null;
  // work once a call delta came, else the answer, even empty and
  // stopped; a round after the run is work, ended by its own step
  const after = afterRun(send);
  const slot = after
    ? "work"
    : send.summarizing
      ? null
      : round.slotMarked
        ? "work"
        : "answer";
  if (slot === "answer") unmarkAnswer(round, send.policy.agentName);
  recordUsage(deps, send, round, now);
  return finishReplyRow(
    deps,
    round,
    after?.status ?? status,
    after ? after.error : error,
    slot,
    null,
    now,
  );
}
