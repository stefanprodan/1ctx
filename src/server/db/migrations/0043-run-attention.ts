// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A run's mark keeps its reason and where it came from: its agent, the
// runner or a decider, the source of every mark made before. Each
// automation picks who marks its runs; a new one defaults to its agent,
// and every one made before keeps the decider as a backup, which still
// asks only while the instance's decision is on.
export const m0043: Migration = {
  id: "0043-run-attention",
  up(db) {
    db.exec(`
      alter table sessions add column attention_reason text;
      alter table sessions add column attention_source text
        check (attention_source in ('agent', 'runner', 'decider'));
      update sessions set attention_source = 'decider'
        where attention is not null;
      alter table automations add column attention_mode text not null
        default 'agent' check (attention_mode in ('off', 'agent', 'decider'));
      alter table automations add column attention_guidance text not null
        default '';
      update automations set attention_mode = 'decider';
    `);
  },
};
