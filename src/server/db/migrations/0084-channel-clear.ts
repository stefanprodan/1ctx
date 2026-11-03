// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// When an admin last cleared a channel, so a tab holding rows from
// before it can tell. Null until the first clear. Added column only.
export const m0084: Migration = {
  id: "0084-channel-clear",
  up(db) {
    db.exec("alter table sessions add column cleared_at integer");
  },
};
