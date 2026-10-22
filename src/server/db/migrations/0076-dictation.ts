// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Dictation's model, one row as smtp_settings is: on when the row is and
// enabled, which a first save leaves off. Off keeps the model, so its
// provider cannot be deleted while the row names it, on or off. A transcribed clip
// leaves one usage row and never its audio or text; the user and the
// provider are kept as text, so the row outlives both. The user's index
// serves the hourly cap, the time's the Monitor's range.
export const m0076: Migration = {
  id: "0076-dictation",
  up(db) {
    db.exec(`
      create table dictation_settings (
        id integer primary key check (id = 1),
        provider_id text not null references providers(id),
        model text not null,
        enabled integer not null default 0 check (enabled in (0, 1)),
        updated_at integer not null
      );

      create table dictation_usage (
        id text primary key,
        user_id text not null,
        provider_id text not null,
        provider_name text not null,
        model text not null,
        seconds real not null,
        cost real,
        created_at integer not null
      );
      create index dictation_usage_user on dictation_usage(user_id, created_at);
      create index dictation_usage_created on dictation_usage(created_at);
    `);
  },
};
