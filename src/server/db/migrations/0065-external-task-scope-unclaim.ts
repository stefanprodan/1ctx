// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A task's part is its scope, and a release is an unclaim. The column is
// renamed in place. The claims and the entries list the old words in
// their checks, so both are rebuilt with every row and rowid kept (a tie
// on time sorts entries by rowid), the stored words rewritten, a sweep's
// own entry text with them, and a claim's saved retry row given the new
// field and kind. Tasks and entries reference claims, so external_tasks
// is checked with them.
export const m0065: Migration = {
  id: "0065-external-task-scope-unclaim",
  rebuild: true,
  rebuilds: ["external_tasks", "external_task_claims", "external_task_entries"],
  up(db) {
    db.exec(`
      alter table external_tasks rename column part to scope;

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
          check (end_reason in ('unclaimed', 'done', 'dropped', 'access_gone', 'idle')),
        last_task text,
        check ((ended_at is null) = (end_reason is null))
      );
      insert into external_task_claims_next
        (rowid, id, task_id, user_id, key_id, key_name, started_at,
         after_entry_id, active_at, ended_at, end_reason, last_task)
      select rowid, id, task_id, user_id, key_id, key_name, started_at,
        after_entry_id, active_at, ended_at,
        case end_reason when 'released' then 'unclaimed' else end_reason end,
        case when last_task is null then null else (
          select case when json_extract(moved, '$.last.kind') = 'release'
            then json_set(moved, '$.last.kind', 'unclaim') else moved end
          from (select json_set(json_remove(last_task, '$.part'), '$.scope',
            json_extract(last_task, '$.part')) as moved)
        ) end
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
          check (kind in ('claim', 'progress', 'question', 'result', 'unclaim', 'answer', 'drop', 'reopen')),
        text text not null,
        links text not null,
        user_id text references users(id) on delete set null,
        key_name text,
        claim_end text
          check (claim_end in ('unclaimed', 'done', 'dropped', 'access_gone', 'idle')),
        at integer not null
      );
      insert into external_task_entries_next
        (rowid, id, task_id, claim_id, kind, text, links, user_id, key_name,
         claim_end, at)
      select rowid, id, task_id, claim_id,
        case kind when 'release' then 'unclaim' else kind end,
        case when key_name is null and claim_end in ('idle', 'access_gone')
          then case
            when text = 'released because access ended' then 'access ended'
            when text like 'released after %'
              then replace(substr(text, 10), 'after 1 hours ', 'after 1 hour ')
            else text end
          else text end,
        links, user_id, key_name,
        case claim_end when 'released' then 'unclaimed' else claim_end end, at
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
