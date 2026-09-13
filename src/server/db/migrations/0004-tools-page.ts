// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Tool settings have complete rows; limits hold overrides only. The
// migration uses zero for initial timestamps because migrations do not
// receive the application's clock.

import type { Migration } from "../migration.ts";

export const m0004: Migration = {
  id: "0004-tools-page",
  up(db) {
    db.exec(`
      create table tools (
        name text primary key
          check (name in ('get_current_time', 'webfetch', 'websearch')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl')),
        updated_at integer not null
      );

      create table limits (
        name text primary key,
        value integer not null,
        updated_at integer not null
      );

      insert into tools (name, enabled, provider, updated_at) values
        ('get_current_time', 1, null, 0),
        ('webfetch', 1, null, 0),
        ('websearch', 1, null, 0);
    `);
  },
};
