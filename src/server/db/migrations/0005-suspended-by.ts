// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// who suspended an automation; null while it runs, and for a row
// suspended before this column
export const m0005: Migration = {
  id: "0005-suspended-by",
  up(db) {
    db.exec(
      "alter table automations add column suspended_by text references users(id)",
    );
  },
};
