// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionResponse } from "../../shared/api/sessions.ts";
import type { Memory } from "../../shared/contracts/memory.ts";
import type {
  LiveSend,
  Message,
  SessionAgent,
  SessionArchive,
  SessionAuthor,
  SessionDetail,
} from "../../shared/contracts/session.ts";
import type { Avatar } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { DAY_MS } from "../lib/clock.ts";
import { offWire, type SessionRow } from "./rows.ts";

// the store's reads the detail is made of
type DetailStore = {
  forkedFrom(id: string): SessionDetail["forkedFrom"];
  messages(id: string): Message[];
  lastSend(id: string): SessionDetail["send"];
  authors(id: string): SessionAuthor[];
  agents(id: string): SessionAgent[];
  archiveOf(id: string, keptDays: number): SessionArchive | null;
  automationDrafts(id: string): SessionDetail["automationDrafts"];
  queue: {
    ofChat(id: string, viewerId: string | null): SessionDetail["queued"];
  };
};

export function detail(
  store: DetailStore,
  session: SessionRow,
  live: LiveSend | null,
  keptDays: number,
  // who reads it: a not-sent message shows to its author alone
  viewerId: string | null,
): SessionResponse {
  return {
    session,
    forkedFrom: store.forkedFrom(session.id),
    messages: store.messages(session.id).map(offWire),
    send: store.lastSend(session.id),
    live,
    authors: store.authors(session.id),
    agents: store.agents(session.id),
    archive: store.archiveOf(session.id, keptDays),
    queued: store.queue.ofChat(session.id, viewerId),
    automationDrafts: store.automationDrafts(session.id),
  };
}

export function authors(db: Db, sessionId: string): SessionAuthor[] {
  return db
    .query<SessionAuthor, [string, string]>(
      `select id, username, full_name as fullName from users
        where id in (select owner_id from sessions where id = ?
                     union select user_id from messages
                      where session_id = ? and user_id is not null)
        order by username`,
    )
    .all(sessionId, sessionId);
}

// the agents the session and its rows name, a retired one included
export function agents(db: Db, sessionId: string): SessionAgent[] {
  return db
    .query<
      { id: string; name: string; avatar: Avatar; retired: number },
      [string, string]
    >(
      `select id, name, avatar, deleted_at is not null as retired
         from agents
        where id in (select agent_id from sessions where id = ?
                     union select agent_id from messages
                      where session_id = ? and agent_id is not null)
        order by name`,
    )
    .all(sessionId, sessionId)
    .map((row) => ({ ...row, retired: row.retired === 1 }));
}

// who archived the chat by hand and when the delete limit removes it;
// null while it is not archived
export function archive(
  db: Db,
  sessionId: string,
  keptDays: number,
): SessionArchive | null {
  const row = db
    .query<
      { at: number; id: string | null; username: string | null },
      [string]
    >(
      `select sessions.archived_at as at, users.id as id,
         users.username as username
         from sessions left join users on users.id = sessions.archived_by
        where sessions.id = ? and sessions.archived_at is not null`,
    )
    .get(sessionId);
  if (row === null) return null;
  return {
    by:
      row.id === null || row.username === null
        ? null
        : { id: row.id, username: row.username },
    keptUntil: row.at + keptDays * DAY_MS,
  };
}

export function sessionInfo(db: Db, sessionId: string): Memory["session"] {
  const row = db
    .query<NonNullable<Memory["session"]>, [string]>(
      `select sessions.id as id, sessions.title as title,
         sessions.origin as origin,
         automations.id as automationId,
         automations.name as automationName
       from sessions
       left join automations on automations.id = sessions.automation_id
       where sessions.id = ?`,
    )
    .get(sessionId);
  return row ?? null;
}
