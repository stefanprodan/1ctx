// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0006: Migration = {
  id: "0006-skills",
  up(db) {
    db.exec(`
      create table skills (
        id text primary key,
        name text not null unique,
        description text not null,
        body text not null,
        license text not null,
        compatibility text not null,
        metadata text not null,
        allowed_tools text not null,
        source_kind text not null
          check (source_kind in ('github', 'archive', 'index', 'file')),
        source_url text not null,
        source_select text not null,
        source_digest text not null,
        digest text not null,
        dropped text not null,
        fetched_at integer not null,
        last_change text,
        refresh_error text,
        refresh_failed_at integer,
        created_at integer not null
      );

      create table skill_files (
        skill_id text not null references skills(id) on delete cascade,
        path text not null,
        content text not null,
        bytes integer not null,
        primary key (skill_id, path)
      );

      create table agent_skills (
        agent_id text not null references agents(id) on delete cascade,
        skill_id text not null references skills(id),
        primary key (agent_id, skill_id)
      );
      create index agent_skills_skill on agent_skills(skill_id);
    `);
  },
};
