// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0017: Migration = {
  id: "0017-chat-uploads",
  up(db) {
    db.exec(`
      create table upload_staged (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        project_id text not null references projects(id) on delete cascade,
        attempt text not null,
        name text not null,
        archive integer not null check (archive in (0, 1)),
        files integer not null,
        bytes integer not null,
        result text not null,
        created_at integer not null,
        expires_at integer not null,
        unique (user_id, attempt)
      );
      create index upload_staged_owner on upload_staged(user_id, project_id);
      create index upload_staged_expiry on upload_staged(expires_at);
      create table upload_staged_files (
        upload_id text not null references upload_staged(id) on delete cascade,
        position integer not null,
        name text not null,
        text text not null,
        bytes integer not null,
        primary key (upload_id, name)
      );
      create table session_uploads (
        session_id text primary key references sessions(id) on delete cascade,
        revision integer not null,
        bytes integer not null,
        files integer not null
      );
      create table session_upload_files (
        session_id text not null references session_uploads(session_id) on delete cascade,
        name text not null,
        text text not null,
        bytes integer not null,
        message_id text not null,
        item text not null,
        archive integer not null check (archive in (0, 1)),
        folder text not null,
        created_at integer not null,
        item_index integer not null default 0 check (item_index >= 0),
        position integer not null default 0 check (position >= 0),
        primary key (session_id, name)
      );
      alter table messages add column uploads text;
    `);
  },
};
