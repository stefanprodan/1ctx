// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A decider's page and a decision's add up their last 30 days of
// answers, each from its own index.
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
