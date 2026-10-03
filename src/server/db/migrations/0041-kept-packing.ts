// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A kept file of an ended session stored compressed: 0 raw and not yet
// tried, -1 raw for good (its frame was no smaller), 1 a frame of its
// stored bytes in data with text null. No check: adding one reads every
// row's blobs, half a minute on a large file, and bash/kept.ts is the
// only writer. The partial index finds the files still to try, in the
// order a batch packs them, and covers what a batch reads to find them,
// so finding them reads no table row; KEPT_PACKABLE in bash/kept.ts
// repeats its predicate.
export const m0041: Migration = {
  id: "0041-kept-packing",
  up(db) {
    db.exec(`
      alter table mcp_kept_files add column packed integer not null default 0;
      create index mcp_kept_files_packable
        on mcp_kept_files (session_id, folder, position, message_id, bytes)
        where packed = 0 and bytes >= 1024;
    `);
  },
};
