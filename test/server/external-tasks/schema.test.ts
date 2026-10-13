// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  CLAIM_ENDS,
  ENTRY_KINDS,
  EXTERNAL_TASK_STATES,
} from "../../../src/shared/words.ts";
import { fixture, refuses } from "./fixture.ts";

test("the schema checks the shared closed words and keeps history independent of keys and files", () => {
  using f = fixture();
  const sql = (table: string) =>
    f.db
      .query<{ sql: string }, [string]>(
        "select sql from sqlite_schema where type = 'table' and name = ?",
      )
      .get(table)!.sql;
  for (const state of EXTERNAL_TASK_STATES)
    expect(sql("external_tasks")).toContain(`'${state}'`);
  for (const kind of ENTRY_KINDS)
    expect(sql("external_task_entries")).toContain(`'${kind}'`);
  for (const end of CLAIM_ENDS) {
    expect(sql("external_task_claims")).toContain(`'${end}'`);
    expect(sql("external_task_entries")).toContain(`'${end}'`);
  }
  const task = f.task("in_progress");
  for (const statement of [
    "update external_tasks set state = 'invalid'",
    "update external_tasks set state = 'open'",
    "update external_tasks set state = 'claimed'",
    "update external_tasks set revision = -1",
    "update external_tasks set edit_revision = -1",
    "update external_task_claims set end_reason = 'access gone'",
    "update external_task_claims set ended_at = 1",
  ])
    expect(() => f.db.exec(statement)).toThrow();
  f.area.report(f.key, task.id, task.claimId!, "progress", "Here.", []);
  expect(() =>
    f.db.exec("update external_task_entries set kind = 'invalid'"),
  ).toThrow();
  expect(() =>
    f.db.exec("update external_task_entries set claim_end = 'access gone'"),
  ).toThrow();
  for (const table of [
    "external_tasks",
    "external_task_files",
    "external_task_labels",
    "external_task_claims",
    "external_task_entries",
  ]) {
    const foreign = f.db
      .query<{ table: string }, []>(`pragma foreign_key_list(${table})`)
      .all()
      .map((r) => r.table);
    for (const absent of ["access_keys", "knowledge_files", "sessions"])
      expect(foreign).not.toContain(absent);
  }
  expect(f.area.store.claimById(task.claimId!)!.key_name).toBe("laptop");
  const indexes = f.db
    .query<{ name: string }, []>(
      "select name from sqlite_schema where type = 'index' and name like 'external_%'",
    )
    .all()
    .map((r) => r.name);
  for (const name of [
    "external_tasks_unfinished",
    "external_tasks_closed",
    "external_task_labels_label",
    "external_task_claims_open",
    "external_task_entries_task",
    "external_task_entries_agent",
    "external_task_entries_reopen",
  ])
    expect(indexes).toContain(name);
  expect(() =>
    f.db
      .query(
        `insert into external_task_claims (id, task_id, user_id, key_id, key_name, started_at, active_at)
      values ('duplicate', ?, ?, 'k2', 'second', 0, 0)`,
      )
      .run(task.id, f.owner.id),
  ).toThrow();
});

test("deleting a task or its project cascades through claims, entries, file and label links", () => {
  using f = fixture();
  const one = f.task("in_progress");
  const two = f.task("in_progress");
  for (const task of [one, two]) {
    f.area.report(f.key, task.id, task.claimId!, "progress", "Started.", []);
    f.db
      .query(
        "insert into external_task_files (task_id, file_id, position) values (?, 'deleted-file', 1)",
      )
      .run(task.id);
  }
  f.area.delete(one.id);
  refuses(
    () => f.area.report(f.key, one.id, one.claimId!, "result", "Too late.", []),
    404,
    "no such external task",
  );
  f.db.query("delete from projects where id = ?").run(f.projectId);
  for (const table of [
    "external_tasks",
    "external_task_files",
    "external_task_labels",
    "external_task_claims",
    "external_task_entries",
  ]) {
    expect(
      f.db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!
        .n,
    ).toBe(0);
  }
  expect(f.db.query("pragma foreign_key_check").all()).toEqual([]);
});

test("a missing originating chat leaves the stored task and is not a live link", () => {
  using f = fixture();
  const made = f.area.create(
    f.owner.id,
    f.projectId,
    { title: "From chat", labels: ["build"], fileIds: ["brief"] },
    "gone-chat",
  );
  expect(made.task.chatId).toBeNull();
  expect(
    f.db
      .query<{ chat_id: string }, [string]>(
        "select chat_id from external_tasks where id = ?",
      )
      .get(made.task.task.id)!.chat_id,
  ).toBe("gone-chat");
  // an edit through it keeps the id, read as no chat
  const edited = f.area.edit(
    f.owner.id,
    made.task.task.id,
    { editRevision: 0, title: "Edited from chat" },
    null,
    "gone-chat",
  );
  expect(edited.entries[0]).toMatchObject({ kind: "edit", chatId: null });
  expect(
    f.db
      .query<{ chat_id: string }, [string]>(
        "select chat_id from external_task_entries where id = ?",
      )
      .get(edited.entries[0]!.id)!.chat_id,
  ).toBe("gone-chat");
});
