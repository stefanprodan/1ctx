// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// what a router's frames say about a round: the upstream that served
// it, the model that answered when it is not the one asked for, and the
// upstream's own stop reason when it differs from the normalized one
export const m0021: Migration = {
  id: "0021-served-by",
  up(db) {
    db.exec(`
      alter table messages add column upstream text;
      alter table messages add column served_model text;
      alter table messages add column native_finish text;
      alter table usage add column upstream text;
      alter table usage add column served_model text;
    `);
  },
};
