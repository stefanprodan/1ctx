// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SessionAgent,
  SessionArchive,
  SessionAuthor,
} from "../../shared/contracts/session.ts";
import type { Avatar } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { ExportRow } from "./markdown.ts";
import { messageUploads } from "./rows.ts";

export function exportRows(db: Db, sessionId: string): ExportRow[] {
  return db
    .query<Omit<ExportRow, "uploads"> & { uploads: string | null }, [string]>(
      `select messages.send_id as sendId, messages.round,
         sends.memory_round as memoryRound, messages.kind, messages.slot,
         messages.status, messages.error, messages.uploads,
         messages.finish_reason as finishReason,
         messages.native_finish as nativeFinish,
         coalesce(users.username, agents.name) as author,
         case when messages.kind = 'user'
             or (messages.kind = 'reply' and messages.slot = 'answer')
           then messages.content else '' end as content,
         messages.created_at as createdAt,
         messages.finished_at as finishedAt
       from messages
       join sends on sends.id = messages.send_id
       left join users on users.id = messages.user_id
       left join agents on agents.id = messages.agent_id
       where messages.session_id = ?
       order by messages.seq`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      uploads: row.kind === "user" ? messageUploads(row.uploads) : null,
    }));
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
    keptUntil: row.at + keptDays * 86_400_000,
  };
}
