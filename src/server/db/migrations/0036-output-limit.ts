// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// what the catalog said a reply of the agent's model may hold, null when
// it did not say, and whether it was read at all: re-read on every save
// and catalog refresh, and a row never read sends no max_tokens. Then
// whether its OpenRouter requests leave out the hosts that serve the
// model at 4 bits
export const m0036: Migration = {
  id: "0036-output-limit",
  up(db) {
    db.exec(`
      alter table agents add column output_limit integer
        check (output_limit is null or output_limit > 0);
      alter table agents add column output_read integer not null
        default 0 check (output_read in (0, 1));
      alter table agents add column skip_4bit integer not null
        default 0 check (skip_4bit in (0, 1));
    `);
  },
};
