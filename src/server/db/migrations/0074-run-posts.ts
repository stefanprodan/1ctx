// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A run's answer posted to its project's channel: the switch on the
// automation, and on the post's row the run's calls and its session,
// cleared when the run is deleted. Added columns, no rebuild.
export const m0074: Migration = {
  id: "0074-run-posts",
  up(db) {
    db.exec(`
      alter table automations add column post_to_channel integer not null
        default 0 check (post_to_channel in (0, 1));
      alter table messages add column run_calls text;
      alter table messages add column run_session_id text
        references sessions(id) on delete set null;
      create index messages_run_session on messages(run_session_id)
        where run_session_id is not null;
    `);
  },
};
