// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the docs a bash call wrote on its tool row, JSON {paths, count, dir}
// with the first paths only, so another agent's trace names them; null
// on every other row
export const m0038: Migration = {
  id: "0038-saved-paths",
  up(db) {
    db.exec("alter table messages add column saved text;");
  },
};
