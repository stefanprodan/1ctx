// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A turn's note (the author's local day) as the model read it, replayed
// in later requests only where it changes. An added column only, so no
// row is copied.
export const m0085: Migration = {
  id: "0085-turn-note",
  up(db) {
    db.exec("alter table messages add column turn_note text;");
  },
};
