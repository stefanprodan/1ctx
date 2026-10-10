// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A task that runs once: the fire that starts its run suspends it and
// sets once_fired_at to the same time, which tells a suspend by its run
// from a member's, and resume clears it.
export const m0056: Migration = {
  id: "0056-automation-once",
  up(db) {
    db.exec(`
      alter table automations add column once integer not null
        default 0 check (once in (0, 1));
      alter table automations add column once_fired_at integer;
    `);
  },
};
