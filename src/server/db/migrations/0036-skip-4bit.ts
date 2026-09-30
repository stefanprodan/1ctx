// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// whether the agent's OpenRouter requests leave out the hosts that serve
// the model at 4 bits
export const m0036: Migration = {
  id: "0036-skip-4bit",
  up(db) {
    db.exec(`
      alter table agents add column skip_4bit integer not null
        default 0 check (skip_4bit in (0, 1));
    `);
  },
};
