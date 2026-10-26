// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The check's Compare path, null for the whole answer. An added column
// only, so no row is copied.
export const m0078: Migration = {
  id: "0078-check-compare",
  up(db) {
    db.exec("alter table automations add column check_compare text;");
  },
};
