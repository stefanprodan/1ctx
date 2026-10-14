// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { newId } from "../../lib/ids.ts";
import type { Migration } from "../migration.ts";

// A claim is an entry on its task's timeline. Nothing references the
// entries, so the wider kind check is a rebuild. Every claim gets its
// entry, placed right after the entry it followed (its after_entry_id),
// and the rowids are renumbered in that order, since a tie on time sorts
// by rowid. A deleted user leaves the entry's user null, as for reports.
export const m0064: Migration = {
  id: "0064-external-task-claim-entries",
  up(db) {
    const ids = db
      .query<{ id: string }, []>("select id from external_task_claims")
      .all()
      .map((claim) => [claim.id, newId()]);
    db.exec(`
      create table external_task_entries_next (
        id text primary key,
        task_id text not null references external_tasks(id) on delete cascade,
        claim_id text references external_task_claims(id) on delete cascade,
        kind text not null
          check (kind in ('claim', 'progress', 'question', 'result', 'release', 'answer', 'drop', 'reopen')),
        text text not null,
        links text not null,
        user_id text references users(id) on delete set null,
        key_name text,
        claim_end text
          check (claim_end in ('released', 'done', 'dropped', 'access_gone', 'idle')),
        at integer not null
      );
    `);
    db.query(
      `insert into external_task_entries_next
        (rowid, id, task_id, claim_id, kind, text, links, user_id, key_name,
         claim_end, at)
      select row_number() over (order by place, step, at, id), id, task_id,
        claim_id, kind, text, links, user_id, key_name, claim_end, at
      from (
        select rowid as place, 0 as step, id, task_id, claim_id, kind, text,
          links, user_id, key_name, claim_end, at
        from external_task_entries
        union all
        select coalesce((select e.rowid from external_task_entries e
            where e.id = c.after_entry_id), 0), 1,
          json_extract(j.value, '$[1]'), c.task_id, c.id, 'claim', '', '[]',
          (select u.id from users u where u.id = c.user_id), c.key_name,
          null, c.started_at
        from json_each(?) j
        join external_task_claims c on c.id = json_extract(j.value, '$[0]')
      )`,
    ).run(JSON.stringify(ids));
    db.exec(`
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
