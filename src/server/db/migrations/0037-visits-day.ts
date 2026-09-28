// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// read by the Access board's VisitStore.onDays
export const m0037: Migration = {
  id: "0037-visits-day",
  up(db) {
    db.exec("create index visits_day on visits(day, user_id)");
  },
};
