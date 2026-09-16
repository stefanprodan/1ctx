// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0011: Migration = {
  id: "0011-gemini",
  rebuild: true,
  up(db) {
    db.exec(`
      create table providers_new (
        id text primary key,
        name text not null unique,
        wire text not null
          check (wire in ('openrouter', 'openai-compatible', 'gemini')),
        base_url text not null,
        key_name text,
        created_at integer not null
      );
      insert into providers_new
        (id, name, wire, base_url, key_name, created_at)
      select id, name, wire, base_url, key_name, created_at from providers;
      drop table providers;
      alter table providers_new rename to providers;
    `);
  },
};
