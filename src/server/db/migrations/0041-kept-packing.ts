// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A kept file of an ended session stored compressed: 0 raw and not yet
// tried, -1 raw for good (its frame was no smaller), 1 a frame of what
// was data and 2 of what was text, both in data with text null, so an
// unpack restores the row as it was. The partial index finds the files
// still to try; KEPT_PACKABLE in bash/kept.ts repeats its predicate.
export const m0041: Migration = {
  id: "0041-kept-packing",
  up(db) {
    db.exec(`
      alter table mcp_kept_files add column packed integer not null default 0
        check (packed in (-1, 0, 1, 2)
          and (packed < 1 or (text is null and data is not null)));
      create index mcp_kept_files_packable on mcp_kept_files (session_id)
        where packed = 0 and bytes >= 1024;
    `);
  },
};
