// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A user's access keys for /mcp. A key is a credential like a login, so
// it is a row holding the token's hash, never a file. project_ids is a
// JSON array of the projects it reaches, null for every one the user
// sees. A name is the user's own, unique among their keys, since a
// write's history names it.
export const m0059: Migration = {
  id: "0059-access-keys",
  up(db) {
    db.exec(`
      create table access_keys (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        name text not null,
        token_hash text not null unique,
        scope text not null check (scope in ('read', 'write')),
        project_ids text,
        created_at integer not null,
        expires_at integer not null,
        last_used_at integer,
        unique (user_id, name)
      );
    `);
  },
};
