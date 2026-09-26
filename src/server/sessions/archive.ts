// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Archiving is for good: the row keeps why and when, and only a manual
// archive names who.

import type { SendSummary } from "../../shared/contracts/session.ts";
import type { ArchiveReason } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { Conflict } from "../lib/errors.ts";
import type { SessionRow } from "./rows.ts";

export const ARCHIVED = "the chat is archived";

// an archived chat takes no turn and no new title; stop stays allowed
export function refuseArchived(session: { archived: unknown }): void {
  if (session.archived !== null) throw new Conflict(ARCHIVED);
}

// false when it is already archived, so a second archive writes nothing
export function archiveRow(
  db: Db,
  id: string,
  reason: ArchiveReason,
  by: string | null,
  now: number,
): boolean {
  return (
    db
      .query(
        `update sessions set archived_at = ?, archived_reason = ?,
           archived_by = ?, revision = revision + 1
         where id = ? and archived_at is null`,
      )
      .run(now, reason, by, id).changes > 0
  );
}

// the agent's chats a delete archives: never a run, which is archived by
// nature once it ends
export function agentChats(db: Db, agentId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      `select id from sessions
       where agent_id = ? and origin = 'chat' and archived_at is null
       order by created_at, id`,
    )
    .all(agentId)
    .map((row) => row.id);
}

// chats and runs on the agent with a send in flight
export function agentRunning(db: Db, agentId: string): number {
  return db
    .query<{ n: number }, [string]>(
      "select count(*) as n from sessions where agent_id = ? and status = 'running'",
    )
    .get(agentId)!.n;
}

// the one envelope an archive publishes: the row, no messages
export function archivedEvent(row: SessionRow, send: SendSummary | null) {
  return {
    type: "session.changed" as const,
    data: { projectId: row.projectId, session: row, messages: [], send },
  };
}
