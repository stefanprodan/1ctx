// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type {
  ClaimEnd,
  EntryKind,
  ExternalTaskState,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import {
  type Claim,
  entryRow,
  type ListInput,
  type OpenClaim,
  type RawEntry,
  type RawTask,
  TASK_SELECT,
  type TaskKey,
  taskRow,
} from "./rows.ts";
import {
  ATTENTION_ROWS,
  type Brief,
  CLOSED_PAGE,
  closed,
  ENTRIES_PAGE,
  parseCursor,
} from "./rules.ts";

const ENTRY = `select e.*, u.username
  from external_task_entries e
  left join users u on u.id = e.user_id`;
const UNFINISHED = "t.state in ('open', 'claimed', 'blocked')";
const CLOSED = "t.state in ('done', 'dropped')";

export class ExternalTaskStore {
  constructor(private readonly db: Db) {}

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

  brief(id: string) {
    const raw = this.db
      .query<
        {
          text: string;
          brief_at: number;
          chat_id: string | null;
        },
        [string]
      >(
        `select text, brief_at,
        case when exists (select 1 from sessions where id = t.chat_id)
          then chat_id end as chat_id from external_tasks t where id = ?`,
      )
      .get(id);
    return raw === null
      ? null
      : {
          text: raw.text,
          briefAt: raw.brief_at,
          chatId: raw.chat_id,
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

  byProject(projectId: string) {
    const tasks = this.db
      .query<RawTask, [string]>(
        `${TASK_SELECT} where t.project_id = ? and ${UNFINISHED}
        order by case t.state when 'blocked' then 0 when 'claimed' then 1 else 2 end,
          t.moved_at desc, t.id`,
      )
      .all(projectId)
      .map(taskRow);
    const count = this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t where t.project_id = ? and ${CLOSED}`,
      )
      .get(projectId)!.n;
    return { tasks, closed: count };
  }

  private page(
    filters: { from?: string; where: string; args: (string | number)[] }[],
    after: string | null,
    limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new BadRequest("invalid page size");
    }
    const cursor = after === null ? null : parseCursor(after);
    const past =
      cursor === null
        ? ""
        : "and (t.moved_at < ? or (t.moved_at = ? and t.id > ?))";
    const values = [
      ...(cursor === null ? [] : [cursor.at, cursor.at, cursor.id]),
      limit + 1,
    ];
    const rows = filters.flatMap(({ from = "external_tasks t", where, args }) =>
      this.db
        .query<Pick<RawTask, "moved_at" | "id">, (string | number)[]>(
          `select t.moved_at, t.id from ${from}
          where ${where} ${past} order by t.moved_at desc, t.id limit ?`,
        )
        .all(...args, ...values),
    );
    rows.sort(
      (a, b) =>
        b.moved_at - a.moved_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hydrated =
      page.length === 0
        ? []
        : this.db
            .query<RawTask, [string]>(
              `${TASK_SELECT} where t.id in (select value from json_each(?))
              order by t.moved_at desc, t.id`,
            )
            .all(JSON.stringify(page.map((row) => row.id)));
    return {
      rows: hydrated.map((raw) => ({
        ...taskRow(raw),
        answered: raw.answered === 1,
        cursor: `${raw.moved_at}.${raw.id}`,
      })),
      next: rows.length > limit && last ? `${last.moved_at}.${last.id}` : null,
    };
  }

  closed(projectId: string, after: string | null, limit = CLOSED_PAGE) {
    const page = this.page(
      [{ where: `t.project_id = ? and ${CLOSED}`, args: [projectId] }],
      after,
      limit,
    );
    return {
      tasks: page.rows.map(({ answered: _, cursor: __, ...row }) => row),
      next: page.next,
    };
  }

  list(input: ListInput) {
    if (input.held !== null) {
      return this.page(
        [
          {
            from: `external_task_claims c cross join external_tasks t
              on t.id = c.task_id and t.claim_id = c.id`,
            where: `c.key_id = ? and c.user_id = ? and c.ended_at is null
              and t.project_id in (select value from json_each(?))`,
            args: [
              input.held.keyId,
              input.held.userId,
              JSON.stringify(input.projectIds),
            ],
          },
        ],
        input.after,
        input.limit,
      );
    }
    const states: ExternalTaskState[] = input.states.length
      ? input.states
      : ["open"];
    const filters = [...new Set(input.projectIds)].flatMap((projectId) =>
      [...new Set(states)].map((state) => ({
        where: `t.project_id = ? and t.state = ? and ${closed(state) ? CLOSED : UNFINISHED}`,
        args: [projectId, state],
      })),
    );
    const page = this.page(filters, input.after, input.limit);
    for (const row of page.rows) row.answered = false;
    return page;
  }

  attention(projectIds: string[]) {
    const where =
      "t.project_id in (select value from json_each(?)) and t.attention_at is not null";
    const ids = JSON.stringify(projectIds);
    const tasks = this.db
      .query<RawTask, [string, number]>(
        `${TASK_SELECT} where t.id in (
          select t.id from external_tasks t indexed by external_tasks_project_attention
          where ${where} order by t.attention_at desc, t.id limit ?
        ) order by t.attention_at desc, t.id`,
      )
      .all(ids, ATTENTION_ROWS)
      .map(taskRow);
    const count = this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t where ${where}`,
      )
      .get(ids)!.n;
    return { tasks, count };
  }

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
    const page = rows.slice(0, ENTRIES_PAGE).map(entryRow);
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

  lastEntry(claimId: string, taskLast: boolean): ExternalTaskEntry | null {
    const latest = taskLast
      ? `and e.rowid = (select rowid from external_task_entries
          where task_id = e.task_id order by at desc, rowid desc limit 1)`
      : "";
    const raw = this.db
      .query<RawEntry, [string]>(
        `${ENTRY} where e.claim_id = ? ${latest} order by e.at desc, e.rowid desc limit 1`,
      )
      .get(claimId);
    return raw ? entryRow(raw) : null;
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
        (id, project_id, title, text, part, created_by, chat_id, created_at, brief_at, moved_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        brief.title,
        brief.text,
        brief.part,
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
        `update external_tasks set title = ?, text = ?, part = ?, brief_at = ?,
        revision = revision + 1, edit_revision = edit_revision + 1 where id = ?`,
      )
      .run(brief.title, brief.text, brief.part, now, id);
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
    },
  ): string {
    const id = newId();
    this.db
      .query(
        `insert into external_task_entries
        (id, task_id, claim_id, kind, text, links, user_id, key_name, claim_end, at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        fields.at,
      );
    return id;
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
