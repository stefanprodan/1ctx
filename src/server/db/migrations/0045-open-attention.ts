// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An automation holds one open alert: attention_since is when it
// opened, null while none is. Its runs are the automation's marked runs
// that ended since, read through the partial index on marked runs,
// which the Runs list's filter reads too; attention rides on it so the
// alert's count never leaves the index. The 0.5 is ATTENTION_AT: a
// query names it as a literal, or SQLite cannot use the index. Nothing
// opens for the runs marked before.
export const m0045: Migration = {
  id: "0045-open-attention",
  up(db) {
    db.exec(`
      alter table automations add column attention_since integer;
      create index automations_attention
        on automations(attention_since desc, id)
        where attention_since is not null;
      create index sessions_marked
        on sessions(automation_id, last_activity_at, id desc, attention)
        where attention >= 0.5;
    `);
  },
};
