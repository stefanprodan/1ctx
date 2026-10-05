// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A decider's page counts its answers and sums their input tokens per
// day over a year, Checks left out; an index holding those columns
// answers it without reading the rows, as the agent's does.
export const m0047: Migration = {
  id: "0047-decision-usage-decider",
  up(db) {
    db.exec(`
      create index decision_usage_decider
        on decision_usage(decider_id, created_at, purpose, input_tokens);
    `);
  },
};
