// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Row writes the writer's transactions share; each runs inside its caller's.

import type { Message } from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import { writeKeptFiles } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { type CutKind, cutKind, cutText } from "../sessions/index.ts";
import type { UsageFields } from "../usage/index.ts";
import type { Offered, ToolResult } from "./policy.ts";
import { toolFinish } from "./results.ts";
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

// a row's name as the cut reads it: an MCP tool by the side the offer
// put it on
export function kindOf(offered: Offered, name: string): CutKind {
  const tool = offered.mcp
    .flatMap((server) => server.tools)
    .find((candidate) => candidate.wireName === name);
  return cutKind(name, tool?.side ?? null);
}

type CutDeps = { db: Db; sessions: SessionsPort; log: Log };

// a completion written as finishTool writes it, under a savepoint: a
// write that fails leaves the row to the cut text, so a bad result
// never holds the send's end
function writeCompletion(
  deps: CutDeps,
  send: ActiveSend,
  rowId: string,
  result: ToolResult,
  now: number,
): Message | null | undefined {
  try {
    return transact(deps.db, () => {
      const row = deps.sessions.finishTool(rowId, toolFinish(result, now));
      if (row !== null && result.kept?.length) {
        writeKeptFiles(deps.db, rowId, result.kept);
      }
      return { result: row, events: [] };
    });
  } catch (error) {
    deps.log.warn("tool end not written", {
      chat: send.sessionId,
      ...errorFields(error, false),
    });
    return undefined;
  }
}

// the open rows at a cut, inside the caller's transaction: a call that
// reported a completion keeps it whole, any other is stopped with the
// cut text. A finish leaves none open; were one, it ended unrecorded.
// A guard means a late tool that already wrote returns null
export function cutOpenTools(
  deps: CutDeps,
  send: ActiveSend,
  offered: Offered,
  cause: SendCause,
  now: number,
): Message[] {
  const changed: Message[] = [];
  for (const [call, open] of send.openTools) {
    const result = send.settled.get(call);
    if (result !== undefined && !result.interrupted) {
      const row = writeCompletion(deps, send, open.rowId, result, now);
      if (row !== undefined) {
        if (row !== null) changed.push(row);
        continue;
      }
    }
    const row = deps.sessions.finishTool(open.rowId, {
      content: cutText(
        cause === "finish" ? "failure" : cause,
        kindOf(offered, open.name),
        result?.discarded === true,
      ),
      status: "stopped",
      error: null,
      finishedAt: now,
    });
    if (row !== null) changed.push(row);
  }
  return changed;
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
