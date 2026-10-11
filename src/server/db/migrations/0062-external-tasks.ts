// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0062: Migration = {
  id: "0062-external-tasks",
  up(db) {
    db.exec(`
      create table external_tasks (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        title text not null,
        text text not null,
        part text,
        state text not null default 'open'
          check (state in ('open', 'claimed', 'blocked', 'done', 'dropped')),
        revision integer not null default 0 check (revision >= 0),
        edit_revision integer not null default 0 check (edit_revision >= 0),
        claim_id text references external_task_claims(id),
        attention_at integer,
        created_by text references users(id) on delete set null,
        chat_id text,
        created_at integer not null,
        brief_at integer not null,
        moved_at integer not null,
        check ((state in ('claimed', 'blocked')) = (claim_id is not null))
      );
      create index external_tasks_unfinished
        on external_tasks(project_id, state, moved_at desc, id)
        where state in ('open', 'claimed', 'blocked');
      create index external_tasks_closed
        on external_tasks(project_id, moved_at desc, id)
        where state in ('done', 'dropped');
      create index external_tasks_attention on external_tasks(attention_at)
        where attention_at is not null;
      create index external_tasks_project_attention
        on external_tasks(project_id, attention_at desc, id)
        where attention_at is not null;
      create index external_tasks_claim on external_tasks(claim_id)
        where claim_id is not null;
      create index external_tasks_expired on external_tasks(moved_at)
        where state in ('done', 'dropped');

      create table external_task_files (
        task_id text not null references external_tasks(id) on delete cascade,
        file_id text not null,
        position integer not null check (position >= 0),
        primary key (task_id, file_id),
        unique (task_id, position)
      );
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
          check (end_reason in ('released', 'done', 'dropped', 'access_gone', 'idle')),
        last_task text,
        check ((ended_at is null) = (end_reason is null))
      );
      create unique index external_task_claims_open
        on external_task_claims(task_id) where ended_at is null;
      create index external_task_claims_key
        on external_task_claims(key_id) where ended_at is null;
      create index external_task_claims_task on external_task_claims(task_id);

      create table external_task_entries (
        id text primary key,
        task_id text not null references external_tasks(id) on delete cascade,
        claim_id text references external_task_claims(id) on delete cascade,
        kind text not null
          check (kind in ('progress', 'question', 'result', 'release', 'answer', 'drop', 'reopen')),
        text text not null,
        links text not null,
        user_id text references users(id) on delete set null,
        key_name text,
        claim_end text
          check (claim_end in ('released', 'done', 'dropped', 'access_gone', 'idle')),
        at integer not null
      );
      -- SQLite appends rowid to this index, breaking ties within a millisecond.
      create index external_task_entries_task
        on external_task_entries(task_id, at);
      create index external_task_entries_claim
        on external_task_entries(claim_id, at);
    `);
  },
};
