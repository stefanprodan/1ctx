// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// what the catalog said about the agent's model thinking: that it
// always thinks, and whether its reasoning flag can be trusted, so
// false means it never does; a saved agent learns both on its next save
export const m0025: Migration = {
  id: "0025-model-thinking",
  up(db) {
    db.exec(`
      alter table agents add column thinking_required integer not null default 0;
      alter table agents add column reasoning_known integer not null default 0;
    `);
  },
};
