// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a send another agent answered in a chat for one turn, summoned by the
// message's first word; the chat's own turns stay 0
export const m0037: Migration = {
  id: "0037-summoned",
  up(db) {
    db.exec(`
      alter table sends add column summoned integer not null
        default 0 check (summoned in (0, 1));
    `);
  },
};
