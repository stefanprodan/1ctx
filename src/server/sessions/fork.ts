// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SendSummary,
  SessionDetail,
} from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { copyKeptFiles } from "../knowledge/index.ts";
import { BadRequest, NotFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { packedText } from "./pack.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type RawSend,
  type SessionRow,
} from "./rows.ts";

type ForkSend = Pick<SendSummary, "id" | "kind" | "memoryRound">;

export type ForkFields = {
  source: SessionRow;
  messageId: string;
  agentId: string;
  // the fork's title; "Fork of <the source's>" when absent
  title?: string;
  ownerId: string;
  now: number;
};

export function forkPoint(
  rows: Message[],
  sends: ForkSend[],
  messageId: string,
): { rows: Message[]; draft: string | null } {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const index = ordered.findIndex((row) => row.id === messageId);
  const point = ordered[index];
  if (!point) throw new NotFound("no such message");
  const bySend = new Map(sends.map((send) => [send.id, send]));
  const memory = (row: Message) => {
    const round = bySend.get(row.sendId)?.memoryRound;
    return round != null && row.round >= round;
  };
  if (memory(point)) throw new BadRequest("not a turn");
  if (point.kind === "user" && point.status === "done") {
    return {
      rows: ordered.filter((row) => row.seq < point.seq && !memory(row)),
      draft: point.content,
    };
  }
  if (
    point.kind !== "reply" ||
    point.slot !== "answer" ||
    (point.status !== "done" && point.status !== "stopped")
  ) {
    throw new BadRequest("not a turn");
  }
  let end = index + 1;
  for (; end < ordered.length; end++) {
    const row = ordered[end]!;
    if (
      row.kind !== "summary" ||
      row.status !== "done" ||
      memory(row) ||
      (row.sendId !== point.sendId &&
        bySend.get(row.sendId)?.kind !== "compact")
    ) {
      break;
    }
  }
  return {
    rows: ordered.slice(0, end).filter((row) => !memory(row)),
    draft: null,
  };
}

export function readForkPoint(db: Db, sessionId: string, messageId: string) {
  const rows = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where session_id = ? order by seq`,
    )
    .all(sessionId)
    .map(message);
  const sends = db
    .query<ForkSend, [string]>(
      "select id, kind, memory_round as memoryRound from sends where session_id = ?",
    )
    .all(sessionId);
  return forkPoint(rows, sends, messageId);
}

export function copyRows(
  db: Db,
  fields: { sessionId: string; rows: Message[]; now: number },
): ReadonlyMap<string, string> {
  const ids = new Map(fields.rows.map((row) => [row.id, newId()]));
  const sendIds = new Map<string, string>();
  const grouped = new Map<string, Message[]>();
  for (const row of fields.rows) {
    const group = grouped.get(row.sendId) ?? [];
    group.push(row);
    grouped.set(row.sendId, group);
  }
  // a source send still running (its summary streams after the answer
  // the fork stops at) is copied as finished: the copy holds settled
  // rows only, and a running send would be ended as a crash at start
  const insertSend = db.query(
    `insert into sends (id, session_id, kind, user_id, agent_id, provider_id,
       provider_name, model, status, cause, error, first_message_id, rounds,
       tool_calls, mcp, memory_round, memory_error, memory_skipped,
       started_at, finished_at)
     select ?, ?, kind, user_id, agent_id, provider_id, provider_name, model,
       case when status = 'running' then 'done' else status end,
       case when status = 'running' then 'finish' else cause end,
       error, ?, ?, ?, null, null, null, null, started_at,
       case when status = 'running' then ? else finished_at end
     from sends where id = ?`,
  );
  for (const [sendId, rows] of grouped) {
    const source = db
      .query<RawSend, [string]>("select * from sends where id = ?")
      .get(sendId);
    const first = source && ids.get(source.first_message_id);
    if (!first) throw new Error("fork send has no copied first message");
    const id = newId();
    sendIds.set(sendId, id);
    insertSend.run(
      id,
      fields.sessionId,
      first,
      rows.reduce((max, row) => Math.max(max, row.round), 0),
      rows.filter((row) => row.kind === "tool").length,
      fields.now,
      sendId,
    );
  }
  const insertMessage = db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round, slot,
       user_id, agent_id, content, reasoning, html, status, error,
       finish_reason, reasoning_details, tool_calls, tool_call_id, tool_name,
       model, ttft_ms, thinking_ms, upstream, served_model, native_finish,
       created_at, finished_at, uploads)
     select ?, ?, seq, kind, ?, round, slot, user_id, agent_id,
       coalesce(?, content), reasoning, html, status, error, finish_reason, reasoning_details,
       tool_calls, tool_call_id, tool_name, model, ttft_ms, thinking_ms,
       upstream, served_model, native_finish,
       created_at, finished_at, uploads from messages where id = ?`,
  );
  const insertOpened = db.query(
    `insert into opened_files
       (message_id, position, path, kind, language, bytes, lines, title, text)
     select ?, position, path, kind, language, bytes, lines, title, text
     from opened_files where message_id = ? order by position`,
  );
  for (const row of fields.rows) {
    const id = ids.get(row.id)!;
    // a fork is live and sends its results every turn, so a packed row
    // is copied plain
    const text = row.resultBytes === null ? null : packedText(db, row.id);
    insertMessage.run(
      id,
      fields.sessionId,
      sendIds.get(row.sendId)!,
      text,
      row.id,
    );
    insertOpened.run(id, row.id);
  }
  const source = fields.rows[0]?.sessionId;
  if (source !== undefined) copyKeptFiles(db, source, fields.sessionId, ids);
  return ids;
}

export function forkedFrom(db: Db, id: string): SessionDetail["forkedFrom"] {
  return db
    .query<NonNullable<SessionDetail["forkedFrom"]>, [string]>(
      `select fork.forked_from_session_id as id, source.title, source.origin
       from sessions as fork
       left join sessions as source on source.id = fork.forked_from_session_id
       where fork.id = ? and fork.forked_from_session_id is not null`,
    )
    .get(id);
}
