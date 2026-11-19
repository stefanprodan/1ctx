// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The sandbox's own network: off, or the hosts listed, null hosts being
// the defaults the server names. Added columns with a check, so the one
// row stays and nothing is copied.
export const m0087: Migration = {
  id: "0087-sandbox-network",
  up(db) {
    db.exec(`
      alter table sandbox_settings add column network text not null
        default 'hosts' check (network in ('off', 'hosts'));
      alter table sandbox_settings add column hosts text;
    `);
  },
};
