// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// users: identity and the password hash (argon2id, PHC string). logins:
// the row behind a cookie, holding a hash of the token so a database
// read never yields a usable cookie.
export const m0001: Migration = {
  id: "0001-users-logins",
  up(db) {
    db.exec(`
      create table users (
        id text primary key,
        name text not null unique,
        role text not null check (role in ('admin', 'member')),
        password_hash text not null,
        created_at integer not null
      );
      create table logins (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        token_hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null,
        expires_at integer not null
      );
      create index logins_user on logins(user_id);
    `);
  },
};
