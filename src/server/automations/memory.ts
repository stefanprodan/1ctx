// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A cursor belongs to one automation and one chat. Marks are only advanced
// after the run commits, so rows here never describe work in flight.

import type { Db } from "../db/index.ts";

export type UnreadChat = {
  id: string;
  title: string;
  author: string;
  lastActivityAt: number;
  userMessages: number;
  readBefore: boolean;
  changedSince: boolean;
};

export type UnreadChats = {
  chats: UnreadChat[];
  remaining: number;
};

export type MemoryMark = {
  sessionId: string;
  readActivityAt: number;
};

type RawUnread = {
  id: string;
  title: string;
  author: string;
  lastActivityAt: number;
  userMessages: number;
  readActivityAt: number | null;
};

export class MemoryMarkerStore {
  constructor(private readonly db: Db) {}

  unread(
    automationId: string,
    projectId: string,
    cap: number,
    exclude: readonly string[] = [],
  ): UnreadChats {
    const omitted = new Set(exclude);
    const rows = this.db
      .query<RawUnread, [string, string]>(
        `select sessions.id, sessions.title, users.username as author,
           sessions.last_activity_at as lastActivityAt,
           (select count(*) from messages
             where messages.session_id = sessions.id
               and messages.kind = 'user') as userMessages,
           automation_memory_reads.read_activity_at as readActivityAt
         from sessions
         join users on users.id = sessions.owner_id
         left join automation_memory_reads
           on automation_memory_reads.session_id = sessions.id
          and automation_memory_reads.automation_id = ?
         where sessions.project_id = ? and sessions.origin = 'chat'
           and sessions.status != 'running'
           and (automation_memory_reads.read_activity_at is null
             or sessions.last_activity_at >
               automation_memory_reads.read_activity_at)
         order by sessions.last_activity_at, sessions.id`,
      )
      .all(automationId, projectId)
      .filter((entry) => !omitted.has(entry.id));
    const selected = rows.slice(0, cap);
    return {
      chats: selected.map((entry) => ({
        id: entry.id,
        title: entry.title,
        author: entry.author,
        lastActivityAt: entry.lastActivityAt,
        userMessages: entry.userMessages,
        readBefore: entry.readActivityAt !== null,
        changedSince: entry.readActivityAt !== null,
      })),
      remaining: rows.length - selected.length,
    };
  }

  mark(automationId: string, marks: readonly MemoryMark[]): number {
    let changed = 0;
    for (const mark of marks) {
      changed += this.db
        .query(
          `insert into automation_memory_reads
             (automation_id, session_id, read_activity_at)
           select automations.id, sessions.id, ?
             from automations join sessions
               on sessions.id = ?
              and sessions.project_id = automations.project_id
              and sessions.origin = 'chat'
            where automations.id = ?
           on conflict (automation_id, session_id) do update set
             read_activity_at = excluded.read_activity_at`,
        )
        .run(mark.readActivityAt, mark.sessionId, automationId).changes;
    }
    return changed;
  }
}
