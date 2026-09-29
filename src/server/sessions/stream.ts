// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a stream row carries beyond the session: its last send and the
// last line a person or the agent wrote, both read for every listed
// id in one query each, so the list costs a few queries however long
// it is. The line is cut in SQL before it reaches the process, so a
// reply of a megabyte weighs nothing here.

import type { EnvelopeRow, StreamRow } from "../../shared/api/sessions.ts";
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
// summary or a tool row: what the stream calls the last line. Kind and
// slot are tested first: status sits past content in the row, so a
// large tool row tested on status first has its overflow pages read
const lineRow = (table: string) =>
  `(${table}.kind = 'user'
     or (${table}.kind = 'reply' and ${table}.slot = 'answer'))
   and ${table}.status != 'streaming' and ${table}.content != ''`;

export const lastLinesSql = (count: number) =>
  `select current.session_id, current.seq,
     substr(current.content, 1, 600) as content,
     coalesce(users.username, agents.name) as author
   from messages current
   left join users on users.id = current.user_id
   left join agents on agents.id = current.agent_id
   where current.session_id in (${Array(count).fill("?").join(", ")})
     and ${lineRow("current")}
     and not exists (
       select 1 from messages later
       where later.session_id = current.session_id
         and later.seq > current.seq
         and ${lineRow("later")}
     )`;

function lastLines(db: Db, sessionIds: string[]) {
  const rows = db
    .query<RawLastLine, string[]>(lastLinesSql(sessionIds.length))
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
// life, and a deleted agent is retired, never removed, so its name stays
function agentNames(db: Db, sessionIds: string[]) {
  const marks = sessionIds.map(() => "?").join(", ");
  const rows = db
    .query<{ session_id: string; name: string; retired: number }, string[]>(
      `select sessions.id as session_id, agents.name,
         agents.deleted_at is not null as retired
       from sessions join agents on agents.id = sessions.agent_id
       where sessions.id in (${marks})`,
    )
    .all(...sessionIds);
  return new Map(
    rows.map((raw) => [
      raw.session_id,
      { name: raw.name, retired: raw.retired === 1 },
    ]),
  );
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
  // by automation, how many runs its grouped line stands for
  counts?: Map<string, number>,
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
      agent: agents.get(raw.id)?.name ?? null,
      agentRetired: agents.get(raw.id)?.retired ?? false,
      send: sends.get(raw.id) ?? null,
      last: lines.get(raw.id) ?? null,
      automation: automationRows.get(raw.id) ?? null,
      runBy: username === undefined ? null : { id: raw.owner_id, username },
      runs:
        raw.automation_id === null
          ? null
          : (counts?.get(raw.automation_id) ?? null),
    };
  });
}

// the send's columns but its computed tokens; the compiler holds the
// list to RawSend both ways
const SEND_COLUMNS = [
  "id",
  "session_id",
  "kind",
  "user_id",
  "agent_id",
  "provider_id",
  "model",
  "status",
  "cause",
  "error",
  "first_message_id",
  "rounds",
  "tool_calls",
  "memory_round",
  "memory_error",
  "memory_skipped",
  "started_at",
  "finished_at",
] as const satisfies readonly Exclude<keyof RawSend, "tokens">[];
// Unlisted is never unless RawSend has a column the list lacks
type Listed<_Unlisted extends never> = (typeof SEND_COLUMNS)[number];
type SendColumn = Listed<
  Exclude<keyof RawSend, "tokens" | (typeof SEND_COLUMNS)[number]>
>;

type RawEnvelopeRow = {
  agent: string;
  retired: number;
  automation_id: string | null;
  automation_name: string | null;
  owner_id: string;
  run_by: string | null;
  line_seq: number | null;
  line_author: string;
  line_content: string | null;
  tokens: number;
} & { [K in SendColumn as `send_${K}`]: RawSend[K] | null };

// The same last send and last line streamRows() reads, for one session,
// as one statement of point lookups: an event fires many times a turn,
// and the list's not-exists scans walk a long chat's every message.
export const ENVELOPE_ROW = `select agents.name as agent,
    agents.deleted_at is not null as retired,
    automations.id as automation_id, automations.name as automation_name,
    sessions.owner_id, runner.username as run_by,
    line.seq as line_seq, substr(line.content, 1, 600) as line_content,
    coalesce(author.username, speaker.name) as line_author,
    ${SEND_COLUMNS.map((column) => `last.${column} as send_${column}`).join(", ")},
    ${sendTokens("last")}
  from sessions
  join agents on agents.id = sessions.agent_id
  left join automations on automations.id = sessions.automation_id
  left join users runner
    on sessions.run_source = 'manual' and runner.id = sessions.owner_id
  left join messages line on line.session_id = sessions.id and line.seq = (
    select newest.seq from messages newest
    where newest.session_id = sessions.id and ${lineRow("newest")}
    order by newest.seq desc limit 1)
  left join users author on author.id = line.user_id
  left join agents speaker on speaker.id = line.agent_id
  left join sends last on last.id = (
    select newest.id from sends newest
    where newest.session_id = sessions.id
    order by newest.started_at desc, newest.rowid desc limit 1)
  where sessions.id = ?`;

/** What a session envelope carries of its stream row, or null when gone. */
export function envelopeRow(db: Db, sessionId: string): EnvelopeRow | null {
  const raw = db.query<RawEnvelopeRow, [string]>(ENVELOPE_ROW).get(sessionId);
  if (raw === null) return null;
  const text = raw.line_content === null ? "" : lineFrom(raw.line_content);
  const sent =
    raw.send_id === null
      ? null
      : send({
          // a send row was found, so none of its not-null columns is null
          ...(Object.fromEntries(
            SEND_COLUMNS.map((column) => [column, raw[`send_${column}`]]),
          ) as Pick<RawSend, SendColumn>),
          tokens: raw.tokens,
        });
  return {
    agent: raw.agent,
    agentRetired: raw.retired === 1,
    send: sent,
    last:
      text === "" || raw.line_seq === null
        ? null
        : { seq: raw.line_seq, author: raw.line_author, text },
    automation:
      raw.automation_id === null || raw.automation_name === null
        ? null
        : { id: raw.automation_id, name: raw.automation_name },
    runBy:
      raw.run_by === null ? null : { id: raw.owner_id, username: raw.run_by },
  };
}
