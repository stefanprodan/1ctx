// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { SessionRow } from "../sessions/index.ts";
import type { UsageFields } from "../usage/index.ts";
import { envelope, lastLine } from "./envelope.ts";
import type { SendPolicy } from "./policy.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import type { SessionsPort } from "./writer-port.ts";

type SummaryDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  usage: { record(fields: UsageFields): unknown };
  render: (markdown: string, streaming: boolean) => string;
  stream: (sessionId: string, frame: SocketEvent) => void;
};

function recordUsage(
  deps: SummaryDeps,
  send: ActiveSend,
  round: RoundState,
  now: number,
): void {
  if (round.usage === null) return;
  const fields: UsageFields = {
    sendId: send.id,
    sessionId: send.sessionId,
    projectId: send.projectId,
    userId: send.policy.userId,
    agentId: send.policy.agentId,
    providerId: send.policy.providerId,
    model: send.policy.model,
    round: send.roundNo,
    promptTokens: round.usage.promptTokens,
    completionTokens: round.usage.completionTokens,
    cachedTokens: round.usage.cachedTokens,
    reasoningTokens: round.usage.reasoningTokens,
    cost: round.usage.cost,
    contextLength: send.policy.contextLength,
    now,
  };
  deps.usage.record(fields);
}

function finishAnswer(
  deps: SummaryDeps,
  send: ActiveSend,
  round: RoundState,
  now: number,
): Message | null {
  const thinkingMs =
    round.thinkingMs ??
    (round.reasoningStartedAt === null ? null : now - round.reasoningStartedAt);
  recordUsage(deps, send, round, now);
  return deps.sessions.finishReply(round.messageId, {
    content: round.content,
    reasoning: round.reasoning,
    reasoningDetails: round.reasoningDetails,
    html: deps.render(round.content, false),
    status: "done",
    error: null,
    finishReason: round.finishReason,
    slot: "answer",
    toolCalls: null,
    ttftMs: round.ttftMs,
    thinkingMs,
    finishedAt: now,
  });
}

export function startSummary(deps: SummaryDeps, send: ActiveSend): Message {
  const round = send.round;
  if (round === null) throw new Error("the answer round is missing");
  const now = deps.clock();
  return transact(deps.db, () => {
    const answer = finishAnswer(deps, send, round, now);
    const summary = deps.sessions.addSummary({
      sessionId: send.sessionId,
      sendId: send.id,
      round: send.roundNo + 1,
      agentId: send.policy.agentId,
      model: send.policy.model,
      now,
    });
    const sendRow = deps.sessions.bumpCounters(send.id, {
      rounds: send.roundNo + 1,
      toolCalls: send.budget.calls,
    })!;
    const session = deps.sessions.touch(send.sessionId, {
      status: "running",
      now,
    })!;
    // the answer this transaction finished is the chat's last line, as
    // it would be from finalizeSend
    const last =
      answer?.status === "done" && answer.slot === "answer"
        ? lastLine(answer, send.policy.agentName)
        : undefined;
    return {
      result: summary,
      events: [
        envelope(
          session,
          answer ? [answer, summary] : [summary],
          sendRow,
          [],
          last,
        ),
      ],
    };
  });
}

export type CompactFields = {
  sendId: string;
  summaryId: string;
  firstMessageId: string;
  session: SessionRow;
  policy: SendPolicy;
};

export type StartedCompact = {
  session: SessionSummary;
  summary: Message;
  send: SendSummary;
};

export function startCompact(
  deps: SummaryDeps,
  fields: CompactFields,
): StartedCompact {
  const now = deps.clock();
  return transact(deps.db, () => {
    const send = deps.sessions.createSend({
      id: fields.sendId,
      kind: "compact",
      sessionId: fields.session.id,
      userId: fields.policy.userId,
      agentId: fields.policy.agentId,
      providerId: fields.policy.providerId,
      model: fields.policy.model,
      firstMessageId: fields.firstMessageId,
      mcpDigest: null,
      now,
    });
    const summary = deps.sessions.addSummary({
      id: fields.summaryId,
      sessionId: fields.session.id,
      sendId: send.id,
      round: 1,
      agentId: fields.policy.agentId,
      model: fields.policy.model,
      now,
    });
    const session = deps.sessions.touch(fields.session.id, {
      status: "running",
      now,
    })!;
    return {
      result: { session, summary, send },
      events: [envelope(session, [summary], send)],
    };
  });
}
