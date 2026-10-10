// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A task that runs once: the fire that starts its run suspends it,
// sets once_fired_at to the same time, which tells a suspend by its run
// from a member's, and names that run, which a restart may rerun and the
// page links; a later Run now never moves it. Resume clears both.
export const m0056: Migration = {
  id: "0056-automation-once",
  up(db) {
    db.exec(`
      alter table automations add column once integer not null
        default 0 check (once in (0, 1));
      alter table automations add column once_fired_at integer;
      alter table automations add column once_run_session_id text
        references sessions(id) on delete set null;
    `);
  },
};
