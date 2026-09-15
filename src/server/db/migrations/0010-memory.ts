// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Project and automation notes, each automation's durable chat cursor,
// the automation switches, and the send's memory phase result.

import type { Migration } from "../migration.ts";

export const m0010: Migration = {
  id: "0010-memory",
  up(db) {
    db.exec(`
      create table memory_notes (
        project_id text not null references projects(id) on delete cascade,
        automation_id text references automations(id) on delete cascade,
        entries text not null,
        previous_entries text,
        revision integer not null,
        updated_at integer not null,
        updated_by text references users(id) on delete set null,
        session_id text references sessions(id) on delete set null
      );
      create unique index memory_notes_project
        on memory_notes(project_id) where automation_id is null;
      create unique index memory_notes_automation
        on memory_notes(automation_id) where automation_id is not null;

      create table automation_memory_reads (
        automation_id text not null
          references automations(id) on delete cascade,
        session_id text not null references sessions(id) on delete cascade,
        read_activity_at integer not null,
        primary key (automation_id, session_id)
      );
      create index automation_memory_reads_session
        on automation_memory_reads(session_id);

      alter table automations add column project_memory integer not null
        default 0 check (project_memory in (0, 1));
      alter table automations add column own_memory integer not null
        default 0 check (own_memory in (0, 1));

      alter table sends add column memory_round integer;
      alter table sends add column memory_error text;
      alter table sends add column memory_skipped integer;
    `);
  },
};
