// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalTaskRow } from "../../shared/contracts/external-task.ts";
import type { ClaimEnd, ExternalTaskState } from "../../shared/words.ts";
import { newId } from "../lib/ids.ts";
import { ExternalTaskEntries } from "./entries.ts";
import { CLOSED, UNFINISHED } from "./lists.ts";
import {
  type Claim,
  type OpenClaim,
  type RawTask,
  TASK_SELECT,
  type TaskKey,
  taskRow,
} from "./rows.ts";
import type { Brief } from "./rules.ts";

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
  brief(id: string) {
    const raw = this.db
      .query<
        {
          text: string;
          brief_at: number;
          chat_id: string | null;
          chat_title: string | null;
        },
        [string]
      >(
        `select t.text, t.brief_at, s.id as chat_id, s.title as chat_title
        from external_tasks t left join sessions s on s.id = t.chat_id
        where t.id = ?`,
      )
      .get(id);
    return raw === null
      ? null
      : {
          text: raw.text,
          briefAt: raw.brief_at,
          chatId: raw.chat_id,
          chatTitle: raw.chat_title,
        };
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

  claimsCount(taskId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from external_task_claims where task_id = ?",
      )
      .get(taskId)!.n;
  }

  openClaims(cutoff?: number): OpenClaim[] {
    const idle =
      cutoff === undefined
        ? ""
        : `and c.active_at <= ?
      and exists (select 1 from external_tasks t
        where t.id = c.task_id and t.state = 'claimed' and t.claim_id = c.id)`;
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
    brief: Brief,
    now: number,
    chatId: string | null,
  ): string {
    const id = newId();
    this.db
      .query(
        `insert into external_tasks
        (id, project_id, title, text, scope, created_by, chat_id, created_at, brief_at, moved_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        brief.title,
        brief.text,
        brief.scope,
        userId,
        chatId,
        now,
        now,
        now,
      );
    this.setFiles(id, brief.fileIds);
    return id;
  }

  private setFiles(id: string, fileIds: string[]): void {
    this.db.query("delete from external_task_files where task_id = ?").run(id);
    const insert = this.db.query(
      "insert into external_task_files (task_id, file_id, position) values (?, ?, ?)",
    );
    fileIds.forEach((fileId, position) => {
      insert.run(id, fileId, position);
    });
  }

  edit(id: string, brief: Brief, now: number): void {
    this.db
      .query(
        `update external_tasks set title = ?, text = ?, scope = ?, brief_at = ?,
        revision = revision + 1, edit_revision = edit_revision + 1 where id = ?`,
      )
      .run(brief.title, brief.text, brief.scope, now, id);
    this.setFiles(id, brief.fileIds);
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

  move(
    id: string,
    state: ExternalTaskState,
    claimId: string | null,
    attentionAt: number | null,
    now: number,
  ): void {
    this.db
      .query(
        `update external_tasks set state = ?, claim_id = ?, attention_at = ?,
        moved_at = case when state <> ? then ? else moved_at end,
        revision = revision + 1 where id = ?`,
      )
      .run(state, claimId, attentionAt, state, now, id);
  }

  seen(id: string, attentionAt: number): boolean {
    return (
      this.db
        .query(
          `update external_tasks set attention_at = null, revision = revision + 1
          where id = ? and attention_at = ?`,
        )
        .run(id, attentionAt).changes > 0
    );
  }

  delete(id: string): void {
    this.db.query("delete from external_tasks where id = ?").run(id);
  }
}
