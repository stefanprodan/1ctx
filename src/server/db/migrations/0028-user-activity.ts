// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A user's page counts their posts, chats and manual runs per day over
// a year, and a day they were signed in as one more. A visit is kept
// once per day in their own zone, with its first instant; the indexes
// answer the counts by user and time without reading other users' rows.
export const m0028: Migration = {
  id: "0028-user-activity",
  up(db) {
    db.exec(`
      create table visits (
        user_id text not null references users(id) on delete cascade,
        day text not null,
        at integer not null,
        primary key (user_id, day)
      ) without rowid;
      create index messages_user_posts
        on messages(user_id, created_at) where kind = 'user';
      create index sessions_owner
        on sessions(owner_id, origin, created_at);
    `);
  },
};
