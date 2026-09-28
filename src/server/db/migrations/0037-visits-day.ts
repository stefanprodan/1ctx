// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The Access board counts who signed in each of the last 30 days by the
// visits' own dates, from an index that reads only those days.
export const m0037: Migration = {
  id: "0037-visits-day",
  up(db) {
    db.exec("create index visits_day on visits(day, user_id)");
  },
};
