// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// the zone a user lives in, for the prompt; a user made before this
// column is in UTC until the profile or an admin says otherwise
export const m0007: Migration = {
  id: "0007-user-tz",
  up(db) {
    db.exec("alter table users add column tz text not null default 'UTC'");
  },
};
