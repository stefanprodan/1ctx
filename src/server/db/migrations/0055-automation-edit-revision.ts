// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The count of saves that changed a field, which an edit names: the
// revision moves on every fire, run end and alert, so a form open on a
// busy task would never save against it.
export const m0055: Migration = {
  id: "0055-automation-edit-revision",
  up(db) {
    db.exec(`
      alter table automations add column edit_revision integer not null
        default 0 check (edit_revision >= 0);
    `);
  },
};
