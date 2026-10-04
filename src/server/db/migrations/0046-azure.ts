// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The azure wire. Widening the check rebuilds providers in place, every
// row kept, with the same columns otherwise; the agents' effort check
// already takes every word the wire adds.
export const m0046: Migration = {
  id: "0046-azure",
  rebuild: true,
  rebuilds: ["providers"],
  up(db) {
    db.exec(`
      create table providers_new (
        id text primary key,
        name text not null unique,
        wire text not null
          check (wire in ('openrouter', 'openai-compatible', 'openai-strict',
            'gemini', 'opencode', 'azure')),
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
