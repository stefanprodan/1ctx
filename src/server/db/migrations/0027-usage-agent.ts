// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An agent's page counts its sends and sums its tokens per day over a
// year, in every project; an index holding those columns answers it
// without reading the rows, as the project one does for the heatmap.
export const m0027: Migration = {
  id: "0027-usage-agent",
  up(db) {
    db.exec(`
      create index usage_agent_activity
        on usage(agent_id, created_at, send_id, prompt_tokens,
                 completion_tokens);
    `);
  },
};
