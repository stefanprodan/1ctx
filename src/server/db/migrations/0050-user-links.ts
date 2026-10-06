// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The links an email carries: a password reset, a sign in and an
// invite. A row is written when its email is queued, with no token; the
// sender mints the token, stores its hash and starts the expiry when it
// sends, so a retry never carries a stored or expired link. One unused
// row per user and purpose, which the partial index holds; a used row
// stays until its expiry so the sweep with the logins takes it.
export const m0050: Migration = {
  id: "0050-user-links",
  up(db) {
    db.exec(`
      create table user_links (
        id text primary key,
        purpose text not null check (purpose in ('reset', 'signin',
          'invite')),
        user_id text not null references users(id) on delete cascade,
        issued_by text references users(id) on delete set null,
        token_hash text unique,
        created_at integer not null,
        expires_at integer not null,
        used_at integer
      );
      create unique index user_links_unused on user_links(user_id, purpose)
        where used_at is null;
      create index user_links_expiry on user_links(expires_at);
    `);
  },
};
