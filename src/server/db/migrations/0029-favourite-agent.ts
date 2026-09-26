// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A new chat starts on the user's favourite agent, else the one an admin
// marked as the default, else the first created. At most one agent is
// marked; a favourite that is deleted clears, so the default answers.
export const m0029: Migration = {
  id: "0029-favourite-agent",
  up(db) {
    db.exec(`
      alter table agents add column is_default integer not null default 0;
      create unique index agents_default on agents(is_default)
        where is_default = 1;
      alter table users add column agent_id text
        references agents(id) on delete set null;
    `);
  },
};
