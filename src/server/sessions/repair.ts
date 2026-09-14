// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Each repaired session gets its own revision and envelope rather than
// a global change nobody hears.

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { RepairedSession, SessionRow } from "./rows.ts";

export function repairRows(
  db: Db,
  now: number,
  error: string,
  reads: {
    touch(id: string): SessionRow;
    message(id: string): Message;
    lastSend(id: string): SendSummary | null;
  },
): RepairedSession[] {
  const ids = db
    .query<{ id: string }, []>(
      `select id from sessions where status = 'running'
       union select session_id from sends where status = 'running'
       union select session_id from messages where status = 'streaming'`,
    )
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  // the reply rows about to end need a slot; a null one becomes an
  // answer before its status moves, so the not-streaming check holds
  db.query(
    "update messages set slot = 'answer' where kind = 'reply' and status = 'streaming' and slot is null",
  ).run();
  // the ids of the rows this repair will end, before they change, so
  // the envelope can read them back
  const changedByStatus = db
    .query<{ id: string; session_id: string }, []>(
      "select id, session_id from messages where status = 'streaming'",
    )
    .all();
  db.query(
    "update sends set status = 'failed', cause = 'restart', error = ?, finished_at = ? where status = 'running'",
  ).run(error, now);
  db.query(
    "update messages set status = 'stopped', error = ?, finished_at = ? where kind = 'tool' and status = 'streaming'",
  ).run(error, now);
  db.query(
    "update messages set status = 'failed', error = ?, finished_at = ? where status = 'streaming'",
  ).run(error, now);
  return ids.map((id) => {
    const session = reads.touch(id);
    const messages = changedByStatus
      .filter((row) => row.session_id === id)
      .map((row) => reads.message(row.id));
    return { session, messages, send: reads.lastSend(id) };
  });
}
