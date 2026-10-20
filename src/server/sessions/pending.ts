// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PendingTurn } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { DAY_MS } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";

export type PendingRow = PendingTurn & { sessionId: string; position: number };
export type PendingCursor = { queuedAt: number; position: number };

const COLUMNS = `id, rowid as position, session_id as sessionId, message_id as messageId,
  author_id as authorId, agent_id as agentId, queued_at as queuedAt, reason`;

export function pendingOf(db: Db, sessionId: string): PendingTurn[] {
  return db
    .query<PendingTurn, [string]>(
      `select id, message_id as messageId, author_id as authorId,
       agent_id as agentId, queued_at as queuedAt, reason
     from pending_turns where session_id = ? order by queued_at, rowid`,
    )
    .all(sessionId);
}

export class PendingStore {
  constructor(private readonly db: Db) {}

  insert(fields: Omit<PendingRow, "id" | "reason" | "position">): PendingRow {
    const id = newId();
    this.db
      .query(
        `insert into pending_turns
       (id, session_id, message_id, author_id, agent_id, queued_at, changed_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        fields.messageId,
        fields.authorId,
        fields.agentId,
        fields.queuedAt,
        fields.queuedAt,
      );
    return this.byId(id)!;
  }

  byId(id: string): PendingRow | null {
    return this.db
      .query<PendingRow, [string]>(
        `select ${COLUMNS} from pending_turns where id = ?`,
      )
      .get(id);
  }

  ofSession(sessionId: string): PendingTurn[] {
    return pendingOf(this.db, sessionId);
  }

  waiting(after: PendingCursor | null, limit: number): PendingRow[] {
    return this.db
      .query<PendingRow, [number, number, number]>(
        `select ${COLUMNS} from pending_turns
       where reason is null and (queued_at, rowid) > (?, ?)
       order by queued_at, rowid limit ?`,
      )
      .all(after?.queuedAt ?? -1, after?.position ?? 0, limit);
  }

  oldestQueuedAt(): number | null {
    return this.db
      .query<{ at: number | null }, []>(
        "select min(queued_at) as at from pending_turns where reason is null",
      )
      .get()!.at;
  }

  userCount(userId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from pending_turns where author_id = ?",
      )
      .get(userId)!.n;
  }

  remove(id: string): boolean {
    return (
      this.db.query("delete from pending_turns where id = ?").run(id).changes >
      0
    );
  }

  claim(id: string, sessionId: string, messageId: string): boolean {
    return (
      this.db
        .query(
          `delete from pending_turns
       where id = ? and session_id = ? and message_id = ? and reason is null`,
        )
        .run(id, sessionId, messageId).changes === 1
    );
  }

  fail(
    id: string,
    reason: NonNullable<PendingTurn["reason"]>,
    now: number,
  ): void {
    this.db
      .query(
        "update pending_turns set reason = ?, changed_at = ? where id = ? and reason is null",
      )
      .run(reason, now, id);
  }

  dropInProject(projectId: string, userId: string): string[] {
    return this.db
      .query<{ session_id: string }, [string, string]>(
        `delete from pending_turns where author_id = ? and session_id in
       (select id from sessions where project_id = ?) returning session_id`,
      )
      .all(userId, projectId)
      .map((row) => row.session_id);
  }

  sweep(now: number): string[] {
    return this.db
      .query<{ session_id: string }, [number]>(
        `delete from pending_turns where reason is not null and changed_at < ?
       returning session_id`,
      )
      .all(now - 7 * DAY_MS)
      .map((row) => row.session_id);
  }
}
