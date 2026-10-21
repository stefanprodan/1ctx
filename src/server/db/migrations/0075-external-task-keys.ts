// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A task an outside agent made over /mcp keeps the key's id and a copy
// of its name, as a claim does, with no foreign key so a deleted key
// leaves both. The partial index serves a key's unfinished count and a
// retried create's title lookup. Added columns, no rebuild.
export const m0075: Migration = {
  id: "0075-external-task-keys",
  up(db) {
    db.exec(`
      alter table external_tasks add column created_key_id text;
      alter table external_tasks add column created_key_name text;
      create index external_tasks_key_unfinished
        on external_tasks(created_key_id)
        where created_key_id is not null
          and state in ('todo', 'in_progress', 'awaiting_input');
    `);
  },
};
