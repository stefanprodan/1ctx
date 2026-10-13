// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// External tasks start over with labels, files and five states, so the
// next migration rebuilds empty tables. Their claims, entries and file
// links go by their cascades; a claim is never deleted first, since a
// task's claim_id points at it with no cascade.
export const m0068: Migration = {
  id: "0068-external-tasks-restart",
  up(db) {
    db.exec("delete from external_tasks");
  },
};
