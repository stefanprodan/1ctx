// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The activity chart counts sends and sums tokens per project and day
// over a year; an index holding those columns answers it without
// reading the rows, twice as fast at a million of them. It starts with
// the old index's columns, so that one goes.
export const m0002: Migration = {
  id: "0002-usage-activity",
  up(db) {
    db.exec(`
      create index usage_activity
        on usage(project_id, created_at, send_id, prompt_tokens,
                 completion_tokens);
      drop index usage_project;
    `);
  },
};
