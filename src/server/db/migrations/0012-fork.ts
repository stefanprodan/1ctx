// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0012: Migration = {
  id: "0012-fork",
  up(db) {
    db.exec(`
      alter table sessions add column forked_from_session_id text;
      alter table sessions add column forked_from_message_id text;
    `);
  },
};
