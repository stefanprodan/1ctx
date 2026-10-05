// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SessionStatus } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { NotFound } from "../lib/errors.ts";
import {
  envelope,
  refuseArchived,
  type SessionRow,
} from "../sessions/index.ts";
import { answerLine } from "./envelope.ts";
import type { SendPolicy } from "./policy.ts";
import { finalizeRound, type ReplyRowsDeps } from "./reply-rows.ts";
import type { ActiveSend } from "./send.ts";

type SummaryDeps = ReplyRowsDeps & { db: Db; clock: Clock };

export type AfterAnswer = {
  // the summary of a chat's turn, or the first work reply after a run
  row: "summary" | "work";
  status: Exclude<SessionStatus, "running">;
  error: string | null;
  counters: {
    memoryRound?: number;
    attentionRound?: number;
    memoryFrom?: number;
  };
};

// the answer finished and the send's next row opened in one transaction;
// its one envelope carries the answer as the chat's last line
export function startAfterAnswer(
  deps: SummaryDeps,
  send: ActiveSend,
  next: AfterAnswer,
): Message {
  const now = deps.clock();
  const round = send.roundNo + 1;
  return transact(deps.db, () => {
    const answer = finalizeRound(deps, send, next.status, next.error, now);
    const fields = {
      sessionId: send.sessionId,
      sendId: send.id,
      round,
      agentId: send.policy.agentId,
      model: send.policy.model,
      now,
    };
    let row: Message;
    if (next.row === "summary") {
      row = deps.sessions.addSummary(fields);
    } else {
      const created = deps.sessions.addReply(fields);
      row = deps.sessions.markSlot(created.id, "work") ?? created;
    }
    const sendRow = deps.sessions.bumpCounters(send.id, {
      ...next.counters,
      rounds: round,
      toolCalls: send.budget.calls,
    })!;
    const session = deps.sessions.touch(send.sessionId, {
      status: "running",
      now,
    })!;
    return {
      result: row,
      events: [
        envelope(
          session,
          answer ? [answer, row] : [row],
          sendRow,
          [],
          answerLine(answer, send.policy.agentName),
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
    const current = deps.sessions.byId(fields.session.id);
    if (current === null) throw new NotFound("no such chat");
    refuseArchived(current);
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
