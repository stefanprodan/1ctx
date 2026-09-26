// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the OpenRouter endpoint tag an agent's requests try first; null lets
// OpenRouter route
export const m0026: Migration = {
  id: "0026-agent-upstream",
  up(db) {
    db.exec("alter table agents add column upstream text");
  },
};
