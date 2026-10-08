// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Each repaired session gets its own revision and envelope rather than
// a global change nobody hears; a subagent's child is ended the same
// way but publishes nothing, since no list or watch ever shows it, and
// its copy of its parent's /tmp goes, since a child is never continued.

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
    dropScratch(id: string): void;
  },
): RepairedSession[] {
  // the feed indexes hold the running rank but lead with the project, so
  // walking one for running rows reads every entry and is slower than the
  // table
  const ids = db
    .query<{ id: string }, []>(
      `select id from sessions not indexed where status = 'running'
       union select session_id from sends where status = 'running'
       union select session_id from messages where status = 'streaming'`,
    )
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const children = new Set(
    db
      .query<{ id: string }, [string]>(
        `select id from sessions
         where id in (select value from json_each(?))
           and parent_session_id is not null`,
      )
      .all(JSON.stringify(ids))
      .map((r) => r.id),
  );
  // the reply rows about to end need a slot; a null one becomes an
  // answer before its status moves, so the not-streaming check holds
  db.query(
    `update messages set slot = case
       when round >= coalesce(
         (select memory_round from sends where sends.id = messages.send_id),
         round + 1
       ) then 'work' else 'answer' end
     where kind = 'reply' and status = 'streaming' and slot is null`,
  ).run();
  // the ids of the rows this repair will end, before they change, so
  // the envelope can read them back
  const changedByStatus = db
    .query<{ id: string; session_id: string }, []>(
      "select id, session_id from messages where status = 'streaming'",
    )
    .all();
  // the memory phase's words only once it began: memory_from, or a
  // memory_round with no attention step from before memory_from existed
  db.query(
    `update sends set status = 'failed', cause = 'restart', error = ?,
       memory_error = case when memory_from is not null
         or (memory_round is not null and attention_round is null)
         then ? else memory_error end,
       finished_at = ? where status = 'running'`,
  ).run(error, error, now);
  db.query(
    `update messages set status = 'stopped', error = ?, finished_at = ?
     where kind = 'tool' and status = 'streaming'
       and tool_name is not 'delegate'`,
  ).run(error, now);
  db.query(
    "update messages set status = 'failed', error = ?, finished_at = ? where status = 'streaming'",
  ).run(error, now);
  for (const id of children) {
    reads.touch(id);
    reads.dropScratch(id);
  }
  return ids
    .filter((id) => !children.has(id))
    .map((id) => {
      const session = reads.touch(id);
      const messages = changedByStatus
        .filter((row) => row.session_id === id)
        .map((row) => reads.message(row.id));
      return { session, messages, send: reads.lastSend(id) };
    });
}
