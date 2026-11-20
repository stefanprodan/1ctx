// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A project may pick its own image variant; null follows the instance's.
// An added nullable column with a check, so no row is copied.
export const m0091: Migration = {
  id: "0091-project-variant",
  up(db) {
    db.exec(`
      alter table projects add column variant text
        check (variant in ('python', 'bun', 'go', 'rust'));
    `);
  },
};
