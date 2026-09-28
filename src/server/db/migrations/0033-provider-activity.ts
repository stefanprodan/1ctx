// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// read by UsageStore.total for a provider
export const m0033: Migration = {
  id: "0033-provider-activity",
  up(db) {
    db.exec(`
      create index usage_provider_activity
        on usage(provider_id, created_at, send_id, prompt_tokens,
                 completion_tokens);
    `);
  },
};
