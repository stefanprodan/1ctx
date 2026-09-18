// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the openai-strict wire, and whether the catalog described an agent's
// model or an admin stated its window and tools flag
export const m0016: Migration = {
  id: "0016-openai-strict",
  rebuild: true,
  up(db) {
    db.exec(`
      create table providers_new (
        id text primary key,
        name text not null unique,
        wire text not null
          check (wire in
            ('openrouter', 'openai-compatible', 'openai-strict', 'gemini')),
        base_url text not null,
        key_name text,
        created_at integer not null
      );
      insert into providers_new
        (id, name, wire, base_url, key_name, created_at)
      select id, name, wire, base_url, key_name, created_at from providers;
      drop table providers;
      alter table providers_new rename to providers;
      alter table agents
        add column model_described integer not null default 1
        check (model_described in (0, 1));
    `);
  },
};
