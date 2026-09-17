// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The name check needs a rebuild. Nothing references tools, and copying
// in row order keeps the existing web settings ahead of the new tool.
export const m0014: Migration = {
  id: "0014-visualize",
  up(db) {
    db.exec(`
      create table tools_next (
        name text primary key check (name in ('webfetch', 'websearch', 'visualize')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl', 'tavily')),
        hosts text not null default '[]',
        updated_at integer not null
      );
      insert into tools_next (name, enabled, provider, updated_at)
        select name, enabled, provider, updated_at from tools order by rowid;
      insert into tools_next (name, hosts, updated_at)
        values ('visualize',
          '["https://cdn.jsdelivr.net","https://cdnjs.cloudflare.com","https://esm.sh","https://unpkg.com"]',
          0);
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
