// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the project memory task is gone: its chat cursors and its switch go,
// and the automations that had it are kept as plain tasks. A chat keeps
// the note its prompt carries and what it has seen of the note since
export const m0023: Migration = {
  id: "0023-chat-memory",
  up(db) {
    db.exec(`
      drop table automation_memory_reads;
      alter table automations drop column project_memory;

      create table memory_views (
        session_id text primary key
          references sessions(id) on delete cascade,
        snapshot text not null,
        seen text not null
      );
    `);
  },
};
