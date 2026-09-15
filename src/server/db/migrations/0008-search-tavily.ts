// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// tavily joins the search providers; a check cannot be widened in
// place, so the table is rebuilt with its rows. Nothing references it.
export const m0008: Migration = {
  id: "0008-search-tavily",
  up(db) {
    db.exec(`
      create table tools_next (
        name text primary key
          check (name in ('datetime', 'webfetch', 'websearch')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl', 'tavily')),
        updated_at integer not null
      );
      insert into tools_next (name, enabled, provider, updated_at)
        select name, enabled, provider, updated_at from tools order by rowid;
      drop table tools;
      alter table tools_next rename to tools;
    `);
  },
};
