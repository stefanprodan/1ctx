// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// what the catalog said a reply of the agent's model may hold, null
// until its model is picked again; and whether its OpenRouter requests
// leave out the hosts that serve the model at 4 bits
export const m0036: Migration = {
  id: "0036-output-limit",
  up(db) {
    db.exec(`
      alter table agents add column output_limit integer;
      alter table agents add column skip_4bit integer not null default 0;
    `);
  },
};
