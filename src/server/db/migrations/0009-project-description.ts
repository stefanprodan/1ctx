// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0009: Migration = {
  id: "0009-project-description",
  up(db) {
    db.exec(`
      alter table projects add column description text not null default '';
    `);
  },
};
