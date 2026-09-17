// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// datetime lost its switch, so only the web tools keep a row; a check
// cannot be narrowed in place, so the table is rebuilt with the rows it
// keeps. Nothing references it.
export const m0013: Migration = {
  id: "0013-web-tools",
  up(db) {
    db.exec(`
      create table tools_next (
        name text primary key check (name in ('webfetch', 'websearch')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl', 'tavily')),
        updated_at integer not null
      );
      insert into tools_next (name, enabled, provider, updated_at)
        select name, enabled, provider, updated_at from tools
        where name in ('webfetch', 'websearch') order by rowid;
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
