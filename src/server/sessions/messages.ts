// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { MessageKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type ReplyFinish,
} from "./rows.ts";

type AgentMessageFields = {
  id?: string;
  sessionId: string;
  sendId: string;
  round: number;
  agentId: string;
  model: string;
  now: number;
};

export function nextSeq(db: Db, sessionId: string): number {
  return db
    .query<{ n: number }, [string]>(
      "select coalesce(max(seq), 0) + 1 as n from messages where session_id = ?",
    )
    .get(sessionId)!.n;
}

function read(db: Db, id: string): Message {
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where id = ?`,
    )
    .get(id)!;
  return message(raw);
}

export function addAgentMessage(
  db: Db,
  kind: Extract<MessageKind, "reply" | "summary">,
  fields: AgentMessageFields,
): Message {
  const id = fields.id ?? newId();
  const seq = nextSeq(db, fields.sessionId);
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round,
       agent_id, model, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?)`,
  ).run(
    id,
    fields.sessionId,
    seq,
    kind,
    fields.sendId,
    fields.round,
    fields.agentId,
    fields.model,
    fields.now,
  );
  return read(db, id);
}

export function addToolRows(
  db: Db,
  calls: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    toolCallId: string;
    toolName: string;
    now: number;
  }[],
): Message[] {
  return calls.map((call) => {
    const id = call.id ?? newId();
    db.query(
      `insert into messages (id, session_id, seq, kind, send_id, round, tool_call_id, tool_name, status, created_at)
       values (?, ?, ?, 'tool', ?, ?, ?, ?, 'streaming', ?)`,
    ).run(
      id,
      call.sessionId,
      nextSeq(db, call.sessionId),
      call.sendId,
      call.round,
      call.toolCallId,
      call.toolName,
      call.now,
    );
    return read(db, id);
  });
}

export function finishReply(db: Db, id: string, fields: ReplyFinish): boolean {
  return (
    db
      .query(
        `update messages set content = ?, reasoning = ?, reasoning_details = ?, html = ?,
       status = ?, error = ?, finish_reason = ?, slot = ?, tool_calls = ?,
       ttft_ms = ?, thinking_ms = ?, upstream = ?, served_model = ?,
       native_finish = ?, finished_at = ?
     where id = ? and status = 'streaming'`,
      )
      .run(
        fields.content,
        fields.reasoning,
        fields.reasoningDetails.length > 0
          ? JSON.stringify(fields.reasoningDetails)
          : null,
        fields.html,
        fields.status,
        fields.error,
        fields.finishReason,
        fields.slot,
        fields.toolCalls && fields.toolCalls.length > 0
          ? JSON.stringify(fields.toolCalls)
          : null,
        fields.ttftMs,
        fields.thinkingMs,
        fields.upstream,
        fields.servedModel,
        fields.nativeFinish,
        fields.finishedAt,
        id,
      ).changes > 0
  );
}
