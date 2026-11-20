// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The default image comes in variants, python unless an admin picks
// another. An added column with a check, so the one row stays and
// nothing is copied; a custom image still replaces the variant.
export const m0090: Migration = {
  id: "0090-sandbox-variant",
  up(db) {
    db.exec(`
      alter table sandbox_settings add column variant text not null
        default 'python' check (variant in ('python', 'bun', 'go', 'rust'));
    `);
  },
};
