// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The sandbox's home is on its own disk, no longer a sized tmpfs, so
// its limit goes; a saved override of a name the server no longer
// knows would fail every read of the limits.
export const m0088: Migration = {
  id: "0088-sandbox-home",
  up(db) {
    db.exec("delete from limits where name = 'sandboxHomeMiB'");
  },
};
