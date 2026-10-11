// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Every session of a project by activity, children included: the feed
// indexes are partial on roots, so without this a project's list and
// search read the whole table and sort it.
export const m0061: Migration = {
  id: "0061-session-activity",
  up(db) {
    db.exec(`
      create index sessions_activity
        on sessions(project_id, last_activity_at desc, id);
    `);
  },
};
