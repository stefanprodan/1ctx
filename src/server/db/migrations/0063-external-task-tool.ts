// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A chat's agent makes and follows its project's external tasks through
// the external_task tool, on until an admin turns it off. Nothing
// references tools, so its wider name check is a rebuild that copies the
// rows in order.
export const m0063: Migration = {
  id: "0063-external-task-tool",
  up(db) {
    db.exec(`
      create table tools_next (
        name text primary key check (name in ('web', 'webfetch', 'websearch',
          'visualize', 'email_user', 'automation', 'external_task')),
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
        values ('external_task', 1, 0);
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
