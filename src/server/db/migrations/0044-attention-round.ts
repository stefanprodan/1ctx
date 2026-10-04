// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A run's attention step is asked after its main rounds, before its
// memory phase. memory_round stays the first round after the run's
// answer, whichever opened it; attention_round and memory_from say where
// each of the two began, null for one that never started.
export const m0044: Migration = {
  id: "0044-attention-round",
  up(db) {
    db.exec(`
      alter table sends add column attention_round integer;
      alter table sends add column memory_from integer;
    `);
  },
};
