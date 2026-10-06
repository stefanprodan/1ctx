// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An agent may email users once an admin turns its tool on, and only
// users who turned email from agents on: both start off. Nothing
// references tools, so its wider name check is a rebuild that copies
// the rows in order; users keeps its rows with an additive column.
export const m0051: Migration = {
  id: "0051-agent-email",
  up(db) {
    db.exec(`
      alter table users add column email_from_agents integer not null
        default 0 check (email_from_agents in (0, 1));
      create table tools_next (
        name text primary key check (name in ('web', 'webfetch', 'websearch',
          'visualize', 'email_user')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl', 'tavily')),
        hosts text not null default '[]',
        mode text not null default 'all' check (mode in ('off', 'all', 'listed')),
        updated_at integer not null
      );
      insert into tools_next (name, enabled, provider, hosts, mode, updated_at)
        select name, enabled, provider, hosts, mode, updated_at from tools
        order by rowid;
      insert into tools_next (name, enabled, updated_at)
        values ('email_user', 0, 0);
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
