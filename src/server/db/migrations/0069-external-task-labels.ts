// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A task is briefed by its title and files and sorted by its project's
// labels, and moves through todo, in progress, awaiting input, done and
// canceled, with no mark. The tables are empty since 0068; tasks lose
// their text, scope and attention mark, and the claims and entries take
// the one-l canceled in their checks; a claim may end at the entry
// limit, and an edit is an entry keeping the chat it came through. A
// label link names the label's id and goes with the task or the label.
export const m0069: Migration = {
  id: "0069-external-task-labels",
  rebuild: true,
  rebuilds: [
    "external_tasks",
    // emptied by 0068's cascade, so its foreign key check runs too
    "external_task_files",
    "external_task_claims",
    "external_task_entries",
  ],
  up(db) {
    db.exec(`
      drop table external_tasks;
      create table external_tasks (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        title text not null,
        state text not null default 'todo'
          check (state in ('todo', 'in_progress', 'awaiting_input', 'done', 'canceled')),
        revision integer not null default 0 check (revision >= 0),
        edit_revision integer not null default 0 check (edit_revision >= 0),
        claim_id text references external_task_claims(id),
        created_by text references users(id) on delete set null,
        chat_id text,
        created_at integer not null,
        brief_at integer not null,
        moved_at integer not null,
        check ((state in ('in_progress', 'awaiting_input')) = (claim_id is not null))
      );
      create index external_tasks_unfinished
        on external_tasks(project_id, state, moved_at desc, id)
        where state in ('todo', 'in_progress', 'awaiting_input');
      create index external_tasks_closed
        on external_tasks(project_id, moved_at desc, id)
        where state in ('done', 'canceled');
      create index external_tasks_claim on external_tasks(claim_id)
        where claim_id is not null;
      create index external_tasks_expired on external_tasks(moved_at)
        where state in ('done', 'canceled');

      drop table external_task_claims;
      create table external_task_claims (
        id text primary key,
        task_id text not null references external_tasks(id) on delete cascade,
        user_id text not null,
        key_id text not null,
        key_name text not null,
        started_at integer not null,
        after_entry_id text,
        active_at integer not null,
        ended_at integer,
        end_reason text
          check (end_reason in ('unclaimed', 'done', 'canceled', 'access_gone', 'idle', 'limit')),
        last_task text,
        check ((ended_at is null) = (end_reason is null))
      );
      create unique index external_task_claims_open
        on external_task_claims(task_id) where ended_at is null;
      create index external_task_claims_key
        on external_task_claims(key_id) where ended_at is null;
      create index external_task_claims_task on external_task_claims(task_id);

      drop table external_task_entries;
      create table external_task_entries (
        id text primary key,
        task_id text not null references external_tasks(id) on delete cascade,
        claim_id text references external_task_claims(id) on delete cascade,
        kind text not null
          check (kind in ('claim', 'progress', 'question', 'result', 'unclaim', 'answer', 'cancel', 'reopen', 'edit')),
        text text not null,
        links text not null,
        user_id text references users(id) on delete set null,
        key_name text,
        claim_end text
          check (claim_end in ('unclaimed', 'done', 'canceled', 'access_gone', 'idle', 'limit')),
        -- the chat an edit came through, kept with no key as the task's is
        chat_id text,
        at integer not null
      );
      -- SQLite appends rowid to this index, breaking ties within a millisecond.
      create index external_task_entries_task
        on external_task_entries(task_id, at);
      create index external_task_entries_claim
        on external_task_entries(claim_id, at);
      -- the agent entries the bounds count since the last reopen, sought
      -- by rowid past any members' entries
      create index external_task_entries_agent
        on external_task_entries(task_id) where key_name is not null;
      create index external_task_entries_reopen
        on external_task_entries(task_id) where kind = 'reopen';

      create table external_task_labels (
        task_id text not null references external_tasks(id) on delete cascade,
        label_id text not null references project_labels(id) on delete cascade,
        position integer not null check (position >= 0),
        primary key (task_id, label_id)
      );
      create index external_task_labels_label
        on external_task_labels(label_id, task_id);
    `);
  },
};
