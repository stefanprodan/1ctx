// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The feed reads each project's rows in its own order and stops at a
// page, where one scan over every project had to sort them all:
// sessions_running holds the few running rows, sessions_feed the chats
// and apart from them the runs whose automation is gone, newest first.
export const m0033: Migration = {
  id: "0033-feed-arms",
  up(db) {
    db.exec(`
      create index sessions_running on sessions(project_id)
        where status = 'running';
      create index sessions_feed
        on sessions(project_id, origin, last_activity_at desc, id)
        where automation_id is null;
    `);
  },
};
