// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0005: Migration = {
  id: "0005-agent-thinking",
  up(db) {
    db.exec(`
      alter table agents add column thinking text
        check (thinking in ('on', 'off'));
      alter table agents add column effort text
        check (effort in ('minimal', 'low', 'medium', 'high', 'xhigh'));
    `);
  },
};
