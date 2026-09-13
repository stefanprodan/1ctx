// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0008: Migration = {
  id: "0008-users-state",
  up(db) {
    db.exec(`
      alter table users add column disabled integer not null default 0;
      alter table users add column must_change_password integer not null default 0;
    `);
  },
};
