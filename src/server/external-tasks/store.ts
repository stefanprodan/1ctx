// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalTaskRow } from "../../shared/contracts/external-task.ts";
import type { ClaimEnd, ExternalTaskState } from "../../shared/words.ts";
import { newId } from "../lib/ids.ts";
import { ExternalTaskEntries } from "./entries.ts";
import { CLOSED, KEY_UNFINISHED, UNFINISHED } from "./lists.ts";
import {
  type Claim,
  type OpenClaim,
  type RawTask,
  TASK_SELECT,
  type TaskKey,
  taskRow,
} from "./rows.ts";

// a brief as stored: the shaped title, label ids and file ids, in order
export type StoredBrief = {
  title: string;
  labelIds: string[];
  fileIds: string[];
};

export class ExternalTaskStore extends ExternalTaskEntries {
  byId(id: string): ExternalTaskRow | null {
    const raw = this.db
      .query<RawTask, [string]>(`${TASK_SELECT} where t.id = ?`)
      .get(id);
    return raw ? taskRow(raw) : null;
  }

  projectOf(id: string): string | null {
    return (
      this.db
        .query<{ project_id: string }, [string]>(
          "select project_id from external_tasks where id = ?",
        )
        .get(id)?.project_id ?? null
    );
  }

  // the chat's title is for a reader who may open it: show() decides
  made(id: string) {
    const raw = this.db
      .query<
        {
          brief_at: number;
          chat_id: string | null;
          chat_title: string | null;
          created_key_id: string | null;
          created_key_name: string | null;
        },
        [string]
      >(
        `select t.brief_at, s.id as chat_id, s.title as chat_title,
          t.created_key_id, t.created_key_name
        from external_tasks t left join sessions s on s.id = t.chat_id
        where t.id = ?`,
      )
      .get(id);
    return raw === null
      ? null
      : {
          briefAt: raw.brief_at,
          chatId: raw.chat_id,
          chatTitle: raw.chat_title,
          createdKeyId: raw.created_key_id,
          createdKeyName: raw.created_key_name,
        };
  }

  // the key a task was made through over /mcp, null for any other
  createdKey(id: string): string | null {
    return (
      this.db
        .query<{ created_key_id: string | null }, [string]>(
          "select created_key_id from external_tasks where id = ?",
        )
        .get(id)?.created_key_id ?? null
    );
  }

  // the unfinished tasks a key made, across every project
  keyUnfinishedCount(keyId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t
        where t.created_key_id = ? and ${KEY_UNFINISHED}`,
      )
      .get(keyId)!.n;
  }

  // the key's unfinished task of that title in the project, which a
  // retried create answers
  keyUnfinishedTitled(
    keyId: string,
    projectId: string,
    title: string,
  ): string | null {
    return (
      this.db
        .query<{ id: string }, [string, string, string]>(
          `select t.id from external_tasks t
          where t.created_key_id = ? and ${KEY_UNFINISHED}
            and t.project_id = ? and t.title = ? limit 1`,
        )
        .get(keyId, projectId, title)?.id ?? null
    );
  }

  labelIds(id: string): string[] {
    return this.db
      .query<{ label_id: string }, [string]>(
        "select label_id from external_task_labels where task_id = ? order by position",
      )
      .all(id)
      .map((row) => row.label_id);
  }

  // the project's labels by name, for the names given that it holds
  projectLabels(projectId: string, names: readonly string[]) {
    return new Map(
      this.db
        .query<{ id: string; name: string }, [string, string]>(
          `select id, name from project_labels where project_id = ?
          and name in (select value from json_each(?))`,
        )
        .all(projectId, JSON.stringify(names))
        .map((row) => [row.name, row.id]),
    );
  }

  fileIds(id: string): string[] {
    return this.db
      .query<{ file_id: string }, [string]>(
        "select file_id from external_task_files where task_id = ? order by position",
      )
      .all(id)
      .map((row) => row.file_id);
  }

  unfinishedCount(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t where t.project_id = ? and ${UNFINISHED}`,
      )
      .get(projectId)!.n;
  }

  claimById(id: string): Claim | null {
    return this.db
      .query<Claim, [string]>("select * from external_task_claims where id = ?")
      .get(id);
  }

  openClaims(cutoff?: number): OpenClaim[] {
    const idle =
      cutoff === undefined
        ? ""
        : `and c.active_at <= ?
      and exists (select 1 from external_tasks t
        where t.id = c.task_id and t.state = 'in_progress' and t.claim_id = c.id)`;
    return this.db
      .query<OpenClaim, number[]>(
        `select c.id, c.task_id, c.key_id from external_task_claims c
        where c.ended_at is null ${idle} order by c.task_id`,
      )
      .all(...(cutoff === undefined ? [] : [cutoff]));
  }

  claimsForKeys(keyIds: readonly string[]): OpenClaim[] {
    return this.db
      .query<OpenClaim, [string]>(
        `select id, task_id, key_id from external_task_claims
        where key_id in (select value from json_each(?)) and ended_at is null`,
      )
      .all(JSON.stringify(keyIds));
  }

  claimsForUser(userId: string, projectIds: readonly string[]): OpenClaim[] {
    return this.db
      .query<OpenClaim, [string, string]>(
        `select c.id, c.task_id, c.key_id from external_tasks t
        join external_task_claims c on c.id = t.claim_id
        where t.project_id in (select value from json_each(?)) and ${UNFINISHED}
          and c.user_id = ? and c.ended_at is null`,
      )
      .all(JSON.stringify(projectIds), userId);
  }

  expired(cutoff: number): string[] {
    return this.db
      .query<{ id: string }, [number]>(
        `select t.id from external_tasks t where ${CLOSED} and t.moved_at <= ? order by t.moved_at`,
      )
      .all(cutoff)
      .map((row) => row.id);
  }

  create(
    projectId: string,
    userId: string,
    brief: StoredBrief,
    now: number,
    chatId: string | null,
    key: TaskKey | null = null,
  ): string {
    const id = newId();
    this.db
      .query(
        `insert into external_tasks
        (id, project_id, title, created_by, chat_id, created_key_id,
          created_key_name, created_at, brief_at, moved_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        brief.title,
        userId,
        chatId,
        key?.keyId ?? null,
        key?.keyName ?? null,
        now,
        now,
        now,
      );
    this.setLinks(id, brief);
    return id;
  }

  private setLinks(id: string, brief: StoredBrief): void {
    for (const [table, column, ids] of [
      ["external_task_files", "file_id", brief.fileIds],
      ["external_task_labels", "label_id", brief.labelIds],
    ] as const) {
      this.db.query(`delete from ${table} where task_id = ?`).run(id);
      const insert = this.db.query(
        `insert into ${table} (task_id, ${column}, position) values (?, ?, ?)`,
      );
      ids.forEach((linked, position) => {
        insert.run(id, linked, position);
      });
    }
  }

  edit(id: string, brief: StoredBrief, now: number): void {
    this.db
      .query(
        `update external_tasks set title = ?, brief_at = ?,
        revision = revision + 1, edit_revision = edit_revision + 1 where id = ?`,
      )
      .run(brief.title, now, id);
    this.setLinks(id, brief);
  }

  startClaim(taskId: string, key: TaskKey, now: number): string {
    const id = newId();
    // An answer before this claim must not count, even in the same millisecond.
    this.db
      .query(
        `insert into external_task_claims
        (id, task_id, user_id, key_id, key_name, started_at, active_at, after_entry_id)
        values (?, ?, ?, ?, ?, ?, ?,
          (select id from external_task_entries where task_id = ?
            order by rowid desc limit 1))`,
      )
      .run(id, taskId, key.userId, key.keyId, key.keyName, now, now, taskId);
    return id;
  }

  endClaim(id: string, reason: ClaimEnd, now: number): void {
    this.db
      .query(
        "update external_task_claims set ended_at = ?, end_reason = ? where id = ?",
      )
      .run(now, reason, id);
  }

  active(id: string, now: number): void {
    this.db
      .query("update external_task_claims set active_at = ? where id = ?")
      .run(now, id);
  }

  remember(claimId: string, row: ExternalTaskRow): void {
    // A lost terminal response stays the same after a member reopens the task.
    this.db
      .query("update external_task_claims set last_task = ? where id = ?")
      .run(JSON.stringify(row), claimId);
  }

  // moved says the entry moves the task's time even in the same state,
  // as a question asked again while awaiting input does
  move(
    id: string,
    state: ExternalTaskState,
    claimId: string | null,
    now: number,
    moved = false,
  ): void {
    this.db
      .query(
        `update external_tasks set state = ?, claim_id = ?,
        moved_at = case when state <> ? or ? then ? else moved_at end,
        revision = revision + 1 where id = ?`,
      )
      .run(state, claimId, state, moved ? 1 : 0, now, id);
  }

  delete(id: string): void {
    this.db.query("delete from external_tasks where id = ?").run(id);
  }
}
