// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// SQLite needs a default when a not-null column is added. Request parsers
// refuse the empty value, so no new row can keep it. The users table is not
// rebuilt because every other table references it and a drop trips those
// foreign keys.

import type { Migration } from "../migration.ts";

export const m0007: Migration = {
  id: "0007-users-email",
  up(db) {
    db.exec(`
      alter table users add column email text not null default '';
      update users set email = username || '@1ctx.dev';
      create unique index users_email on users(email);
    `);
  },
};
