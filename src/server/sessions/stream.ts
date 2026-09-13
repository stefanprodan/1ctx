// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a stream row carries beyond the session: its last send and the
// last line a person or the agent wrote, both read for every listed
// id in one query each, so the list costs three queries however long
// it is. The line is cut in SQL before it reaches the process, so a
// reply of a megabyte weighs nothing here.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { LastLine, RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { lineFrom } from "./parse.ts";
import { type RawSend, type RawSession, send, session } from "./rows.ts";

type RawLastLine = {
  session_id: string;
  seq: number;
  author: string;
  content: string;
};

// the same row lastSend() answers for one session, for many at once
function lastSends(db: Db, sessionIds: string[]) {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db
    .query<RawSend, string[]>(
      `select current.* from sends current
       where current.session_id in (${marks})
         and not exists (
           select 1 from sends later
           where later.session_id = current.session_id
             and (later.started_at > current.started_at
               or (later.started_at = current.started_at
                 and later.rowid > current.rowid))
         )`,
    )
    .all(...sessionIds);
  return new Map(rows.map((raw) => [raw.session_id, send(raw)]));
}

// a user message or a finished answer reply, never a work reply, a
// summary or a tool row: what the stream calls the last line
function lastLines(db: Db, sessionIds: string[]) {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db
    .query<RawLastLine, string[]>(
      `select current.session_id, current.seq,
         substr(current.content, 1, 600) as content,
         coalesce(users.username, agents.name) as author
       from messages current
       left join users on users.id = current.user_id
       left join agents on agents.id = current.agent_id
       where current.session_id in (${marks})
         and current.status != 'streaming'
         and current.content != ''
         and (current.kind = 'user'
           or (current.kind = 'reply' and current.slot = 'answer'))
         and not exists (
           select 1 from messages later
           where later.session_id = current.session_id
             and later.seq > current.seq
             and later.status != 'streaming'
             and later.content != ''
             and (later.kind = 'user'
               or (later.kind = 'reply' and later.slot = 'answer'))
         )`,
    )
    .all(...sessionIds);
  const out = new Map<string, LastLine>();
  for (const raw of rows) {
    const text = lineFrom(raw.content);
    // a row of markers alone says nothing; the stream shows no line
    if (text !== "") {
      out.set(raw.session_id, { seq: raw.seq, author: raw.author, text });
    }
  }
  return out;
}

export function streamRows(
  db: Db,
  raws: RawSession[],
  usage: Map<string, RoundUsage>,
): StreamRow[] {
  if (raws.length === 0) return [];
  const ids = raws.map((raw) => raw.id);
  const sends = lastSends(db, ids);
  const lines = lastLines(db, ids);
  return raws.map((raw) => ({
    session: session(raw, usage.get(raw.id) ?? null),
    send: sends.get(raw.id) ?? null,
    last: lines.get(raw.id) ?? null,
  }));
}
