// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Nothing references tools. Its wider name check needs a rebuild, while
// sessions and automations keep their rows with an additive column.
export const m0018: Migration = {
  id: "0018-web-access",
  up(db) {
    db.exec(`
      alter table sessions add column disabled_capabilities text not null default '[]';
      alter table automations add column disabled_capabilities text not null default '[]';
      create table tools_next (
        name text primary key check (name in ('web', 'webfetch', 'websearch', 'visualize')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl', 'tavily')),
        hosts text not null default '[]',
        mode text not null default 'all' check (mode in ('off', 'all', 'listed')),
        updated_at integer not null
      );
      insert into tools_next (name, enabled, provider, hosts, updated_at)
        select name, enabled,
          case when name = 'websearch' and enabled = 0 then null else provider end,
          hosts, updated_at from tools order by rowid;
      insert into tools_next (name, mode, updated_at)
        select 'web',
          case when not exists (
            select 1 from tools where name in ('webfetch', 'websearch')
          ) or exists (
            select 1 from tools where name in ('webfetch', 'websearch') and enabled = 1
          ) then 'all' else 'off' end,
          coalesce(max(updated_at), 0) from tools
          where name in ('webfetch', 'websearch');
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
