// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An agent's and a provider's last 30 days sum the cost too: with it in
// their indexes the totals read the index alone, never the table.
export const m0035: Migration = {
  id: "0035-usage-cost-index",
  up(db) {
    db.exec(`
      drop index usage_agent_activity;
      create index usage_agent_activity
        on usage(agent_id, created_at, send_id, prompt_tokens,
                 completion_tokens, cost);
      drop index usage_provider_activity;
      create index usage_provider_activity
        on usage(provider_id, created_at, send_id, prompt_tokens,
                 completion_tokens, cost);
    `);
  },
};
