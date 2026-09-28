// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0033: Migration = {
  id: "0033-feed-arms",
  up(db) {
    // Rank and title let filtered feeds stop and search inside project ranges.
    db.exec(`
      create index sessions_feed
        on sessions(project_id, origin, (status = 'running') desc,
          last_activity_at desc, id, title);
    `);
    // All skips live automation history without visiting unrelated projects.
    db.exec(`
      create index sessions_feed_unowned
        on sessions(project_id, (status = 'running') desc,
          last_activity_at desc, id, title)
        where automation_id is null;
    `);
  },
};
