// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// read by DecisionUsageStore.total, by decider and by decision
export const m0034: Migration = {
  id: "0034-decision-activity",
  up(db) {
    db.exec(`
      create index decision_usage_decider
        on decision_usage(decider_id, created_at);
      create index decision_usage_purpose
        on decision_usage(purpose, created_at);
    `);
  },
};
