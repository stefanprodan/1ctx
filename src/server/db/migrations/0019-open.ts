// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0019: Migration = {
  id: "0019-open",
  up(db) {
    db.exec(`
      create table opened_files (
        message_id text not null references messages(id) on delete cascade,
        position integer not null check (position >= 0),
        path text not null,
        kind text not null check (kind in ('visual', 'markdown', 'code')),
        language text,
        bytes integer not null,
        lines integer not null,
        title text,
        text text not null,
        primary key (message_id, position)
      );
    `);
  },
};
