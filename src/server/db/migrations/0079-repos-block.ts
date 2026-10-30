// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A turn's repository block (its mounts' commits and moved branches) as
// the model read it, replayed byte for byte in every later request. An
// added column only, so no row is copied.
export const m0079: Migration = {
  id: "0079-repos-block",
  up(db) {
    db.exec("alter table messages add column repos_block text;");
  },
};
