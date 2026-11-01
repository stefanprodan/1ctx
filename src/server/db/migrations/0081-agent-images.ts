// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Whether an agent's model reads images: model_images is the catalog's
// word at save, null when it did not say; images is the agent's flag,
// the catalog's when it said and the admin's otherwise. Every agent
// saved before reads none until it is saved again. Added columns only.
export const m0081: Migration = {
  id: "0081-agent-images",
  up(db) {
    db.exec(`
      alter table agents add column model_images integer
        check (model_images is null or model_images in (0, 1));
      alter table agents add column images integer not null default 0
        check (images in (0, 1));
    `);
  },
};
