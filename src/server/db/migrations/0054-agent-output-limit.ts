// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The most a reply of the agent's model may hold, kept from the catalog
// at save as the window is; only the anthropic catalog says, and that
// wire must send a cap. Null for every agent saved before, as for any
// catalog that does not say.
export const m0054: Migration = {
  id: "0054-agent-output-limit",
  up(db) {
    db.exec(`
      alter table agents add column output_limit integer
        check (output_limit is null or output_limit > 0);
    `);
  },
};
