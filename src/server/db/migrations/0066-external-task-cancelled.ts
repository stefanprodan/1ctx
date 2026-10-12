// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A dropped task is cancelled, and a drop is a cancel. The tasks, the
// claims and the entries list the old words in their checks, and the
// closed and expired indexes in their filters, so all three are rebuilt
// with every row and rowid kept (a tie on time sorts entries by rowid),
// the stored words rewritten, a claim's saved retry row with them, and
// every index made again. Claims, entries and files reference tasks,
// and tasks and entries reference claims, so the three are checked.
export const m0066: Migration = {
  id: "0066-external-task-cancelled",
  rebuild: true,
  rebuilds: ["external_tasks", "external_task_claims", "external_task_entries"],
  up(db) {
    db.exec(`
      create table external_tasks_next (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        title text not null,
        text text not null,
        scope text,
        state text not null default 'open'
          check (state in ('open', 'claimed', 'blocked', 'done', 'cancelled')),
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
      insert into external_tasks_next
        (rowid, id, project_id, title, text, scope, state, revision,
         edit_revision, claim_id, attention_at, created_by, chat_id,
         created_at, brief_at, moved_at)
      select rowid, id, project_id, title, text, scope,
        case state when 'dropped' then 'cancelled' else state end,
        revision, edit_revision, claim_id, attention_at, created_by, chat_id,
        created_at, brief_at, moved_at
      from external_tasks;
      drop table external_tasks;
      alter table external_tasks_next rename to external_tasks;
      create index external_tasks_unfinished
        on external_tasks(project_id, state, moved_at desc, id)
        where state in ('open', 'claimed', 'blocked');
      create index external_tasks_closed
        on external_tasks(project_id, moved_at desc, id)
        where state in ('done', 'cancelled');
      create index external_tasks_attention on external_tasks(attention_at)
        where attention_at is not null;
      create index external_tasks_project_attention
        on external_tasks(project_id, attention_at desc, id)
        where attention_at is not null;
      create index external_tasks_claim on external_tasks(claim_id)
        where claim_id is not null;
      create index external_tasks_expired on external_tasks(moved_at)
        where state in ('done', 'cancelled');

      create table external_task_claims_next (
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
          check (end_reason in ('unclaimed', 'done', 'cancelled', 'access_gone', 'idle')),
        last_task text,
        check ((ended_at is null) = (end_reason is null))
      );
      insert into external_task_claims_next
        (rowid, id, task_id, user_id, key_id, key_name, started_at,
         after_entry_id, active_at, ended_at, end_reason, last_task)
      select rowid, id, task_id, user_id, key_id, key_name, started_at,
        after_entry_id, active_at, ended_at,
        case end_reason when 'dropped' then 'cancelled' else end_reason end,
        case
          when last_task is null then null
          when json_extract(last_task, '$.state') = 'dropped'
            or json_extract(last_task, '$.last.kind') = 'drop'
          then (
            select case when json_extract(moved, '$.last.kind') = 'drop'
              then json_set(moved, '$.last.kind', 'cancel') else moved end
            from (select case when json_extract(last_task, '$.state') = 'dropped'
              then json_set(last_task, '$.state', 'cancelled')
              else last_task end as moved)
          )
          else last_task end
      from external_task_claims;
      drop table external_task_claims;
      alter table external_task_claims_next rename to external_task_claims;
      create unique index external_task_claims_open
        on external_task_claims(task_id) where ended_at is null;
      create index external_task_claims_key
        on external_task_claims(key_id) where ended_at is null;
      create index external_task_claims_task on external_task_claims(task_id);

      create table external_task_entries_next (
        id text primary key,
        task_id text not null references external_tasks(id) on delete cascade,
        claim_id text references external_task_claims(id) on delete cascade,
        kind text not null
          check (kind in ('claim', 'progress', 'question', 'result', 'unclaim', 'answer', 'cancel', 'reopen')),
        text text not null,
        links text not null,
        user_id text references users(id) on delete set null,
        key_name text,
        claim_end text
          check (claim_end in ('unclaimed', 'done', 'cancelled', 'access_gone', 'idle')),
        at integer not null
      );
      insert into external_task_entries_next
        (rowid, id, task_id, claim_id, kind, text, links, user_id, key_name,
         claim_end, at)
      select rowid, id, task_id, claim_id,
        case kind when 'drop' then 'cancel' else kind end,
        text, links, user_id, key_name,
        case claim_end when 'dropped' then 'cancelled' else claim_end end, at
      from external_task_entries;
      drop table external_task_entries;
      alter table external_task_entries_next rename to external_task_entries;
      -- SQLite appends rowid to this index, breaking ties within a millisecond.
      create index external_task_entries_task
        on external_task_entries(task_id, at);
      create index external_task_entries_claim
        on external_task_entries(claim_id, at);
    `);
  },
};
