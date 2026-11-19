// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A project may pick its own shell backend; null follows the instance's
// sandbox setting, so every project made before keeps its shell.
export const m0089: Migration = {
  id: "0089-project-backend",
  up(db) {
    db.exec(`
      alter table projects add column backend text
        check (backend in ('builtin', 'openshell'));
    `);
  },
};
