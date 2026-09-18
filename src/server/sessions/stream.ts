// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a stream row carries beyond the session: its last send and the
// last line a person or the agent wrote, both read for every listed
// id in one query each, so the list costs a few queries however long
// it is. The line is cut in SQL before it reaches the process, so a
// reply of a megabyte weighs nothing here.

import type { StreamRow } from "../../shared/api/sessions.ts";
import type { LastLine, RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { lineFrom } from "./parse.ts";
import {
  type RawSend,
  type RawSession,
  send,
  sendTokens,
  session,
} from "./rows.ts";

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
      `select current.*, ${sendTokens("current")} from sends current
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

function automations(db: Db, sessionIds: string[]) {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db
    .query<{ session_id: string; id: string; name: string }, string[]>(
      `select sessions.id as session_id, automations.id, automations.name
       from sessions join automations on automations.id = sessions.automation_id
       where sessions.id in (${marks})`,
    )
    .all(...sessionIds);
  return new Map(
    rows.map((raw) => [raw.session_id, { id: raw.id, name: raw.name }]),
  );
}

// the agent of each session by name; a session keeps its agent for
// life and an agent in use cannot be deleted
function agentNames(db: Db, sessionIds: string[]) {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db
    .query<{ session_id: string; name: string }, string[]>(
      `select sessions.id as session_id, agents.name
       from sessions join agents on agents.id = sessions.agent_id
       where sessions.id in (${marks})`,
    )
    .all(...sessionIds);
  return new Map(rows.map((raw) => [raw.session_id, raw.name]));
}

// who pressed Run now on each manual run, by the session's owner
function runners(db: Db, raws: RawSession[]) {
  const manual = raws.filter((raw) => raw.run_source === "manual");
  if (manual.length === 0) return new Map<string, string>();
  const ids = [...new Set(manual.map((raw) => raw.owner_id))];
  const marks = ids.map(() => "?").join(", ");
  const rows = db
    .query<{ id: string; username: string }, string[]>(
      `select id, username from users where id in (${marks})`,
    )
    .all(...ids);
  return new Map(rows.map((raw) => [raw.id, raw.username]));
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
  const automationRows = automations(db, ids);
  const names = runners(db, raws);
  const agents = agentNames(db, ids);
  return raws.map((raw) => {
    const username =
      raw.run_source === "manual" ? names.get(raw.owner_id) : undefined;
    return {
      session: session(raw, usage.get(raw.id) ?? null),
      agent: agents.get(raw.id) ?? null,
      send: sends.get(raw.id) ?? null,
      last: lines.get(raw.id) ?? null,
      automation: automationRows.get(raw.id) ?? null,
      runBy: username === undefined ? null : { id: raw.owner_id, username },
    };
  });
}
