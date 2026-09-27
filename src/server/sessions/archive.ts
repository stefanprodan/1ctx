// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Archiving is for good: the row keeps why and when, and only a manual
// archive names who.

import type { AgentActivity } from "../../shared/api/agents.ts";
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

// when each live agent last started a send and whether one runs now:
// one seek per agent into the sends by agent, and one into the partial
// index of those in flight; an agent that never ran has no entry
export function agentActivity(db: Db): AgentActivity[] {
  return db
    .query<{ agentId: string; lastAt: number | null; running: number }, []>(
      `select a.id as agentId,
              (select max(s.started_at) from sends s
                where s.agent_id = a.id) as lastAt,
              exists (select 1 from sends s
                where s.agent_id = a.id and s.status = 'running') as running
         from agents a
        where a.deleted_at is null`,
    )
    .all()
    .flatMap((row) =>
      row.lastAt === null
        ? []
        : [
            {
              agentId: row.agentId,
              lastAt: row.lastAt,
              running: row.running === 1,
            },
          ],
    );
}

// the one envelope an archive or an attention mark publishes: the row,
// no messages
export function archivedEvent(row: SessionRow, send: SendSummary | null) {
  return {
    type: "session.changed" as const,
    data: { projectId: row.projectId, session: row, messages: [], send },
  };
}
