// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0004: Migration = {
  id: "0004-run-source",
  up(db) {
    db.exec(
      "alter table sessions add column run_source text check (run_source in ('schedule', 'manual'))",
    );
  },
};
