// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0033: Migration = {
  id: "0033-feed-arms",
  up(db) {
    // Rank and title let filtered feeds stop and search inside project
    // ranges. The project prefix serves every lookup by project, so
    // sessions_project would only cost writes.
    db.exec(`
      drop index sessions_project;
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
    // Read backwards, the runs come newest first with ties by id, and
    // All's search for the newest match never leaves the index. Partial,
    // so chats' writes skip it and no automation_id is null lookup can
    // use it: the runs a deleted automation left have their own small
    // index for the sweep that deletes them.
    db.exec(`
      drop index sessions_automation;
      create index sessions_automation
        on sessions(automation_id, last_activity_at, id desc, title)
        where automation_id is not null;
      create index sessions_orphan_runs on sessions(last_activity_at)
        where origin = 'automation' and automation_id is null;
    `);
  },
};
