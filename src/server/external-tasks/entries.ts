// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalTaskEntry } from "../../shared/contracts/external-task.ts";
import type { ClaimEnd, EntryKind } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { ExternalTaskLists } from "./lists.ts";
import { agentSince, claimsSince, entryRow, type RawEntry } from "./rows.ts";
import { ENTRIES_PAGE } from "./rules.ts";

const ENTRY = `select e.*, u.username, s.id as chat, s.title as chat_title
  from external_task_entries e
  left join users u on u.id = e.user_id
  left join sessions s on s.id = e.chat_id`;

// a task's timeline: appended, paged newest first, read one by one
export class ExternalTaskEntries extends ExternalTaskLists {
  entries(taskId: string, before: string | null) {
    const cursor =
      before === null
        ? null
        : this.db
            .query<{ at: number; rowid: number }, [string, string]>(
              "select at, rowid from external_task_entries where task_id = ? and id = ?",
            )
            .get(taskId, before);
    if (before !== null && cursor === null)
      throw new BadRequest("invalid entry cursor");
    const past =
      cursor === null ? "" : "and (e.at < ? or (e.at = ? and e.rowid < ?))";
    const args = [
      taskId,
      ...(cursor === null ? [] : [cursor.at, cursor.at, cursor.rowid]),
      ENTRIES_PAGE + 1,
    ];
    const rows = this.db
      .query<RawEntry, (string | number)[]>(
        `${ENTRY} where e.task_id = ? ${past} order by e.at desc, e.rowid desc limit ?`,
      )
      .all(...args);
    const page = rows.slice(0, ENTRIES_PAGE).map((raw) => entryRow(raw, true));
    return {
      entries: page,
      next: rows.length > ENTRIES_PAGE ? page.at(-1)!.id : null,
    };
  }

  entry(taskId: string, id: string): ExternalTaskEntry | null {
    const raw = this.db
      .query<RawEntry, [string, string]>(
        `${ENTRY} where e.id = ? and e.task_id = ?`,
      )
      .get(id, taskId);
    return raw === null ? null : entryRow(raw);
  }

  // an edit is no move, so a retry after one still answers the first
  lastEntry(claimId: string, taskLast: boolean): ExternalTaskEntry | null {
    const latest = taskLast
      ? `and e.rowid = (select rowid from external_task_entries
          where task_id = e.task_id and kind <> 'edit'
          order by at desc, rowid desc limit 1)`
      : "";
    const raw = this.db
      .query<RawEntry, [string]>(
        `${ENTRY} where e.claim_id = ? ${latest} order by e.at desc, e.rowid desc limit 1`,
      )
      .get(claimId);
    return raw ? entryRow(raw) : null;
  }

  // the entries the bounds count: an agent's since the last reopen;
  // members and 1ctx write none with a key name
  counted(taskId: string): number {
    return this.db
      .query<{ n: number }, [string, string]>(`select ${agentSince("?")} as n`)
      .get(taskId, taskId)!.n;
  }

  claimsSinceReopen(taskId: string): number {
    return this.db
      .query<{ n: number }, [string, string]>(`select ${claimsSince("?")} as n`)
      .get(taskId, taskId)!.n;
  }

  append(
    taskId: string,
    fields: {
      claimId: string | null;
      kind: EntryKind;
      text: string;
      links: string[];
      userId: string | null;
      keyName: string | null;
      claimEnd: ClaimEnd | null;
      at: number;
      // the chat an edit came through
      chatId?: string | null;
    },
  ): string {
    const id = newId();
    this.db
      .query(
        `insert into external_task_entries
        (id, task_id, claim_id, kind, text, links, user_id, key_name, claim_end, chat_id, at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        fields.claimId,
        fields.kind,
        fields.text,
        JSON.stringify(fields.links),
        fields.userId,
        fields.keyName,
        fields.claimEnd,
        fields.chatId ?? null,
        fields.at,
      );
    return id;
  }
}
