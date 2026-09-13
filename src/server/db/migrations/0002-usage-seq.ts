// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// usage gains its order within the session, so "the last round the
// provider counted" is one deterministic row: the round number resets
// per send, the ids are random and the clock can repeat. Existing rows
// are ordered by time, then by insertion. It also
// keeps the model's window as the policy saw it, so a readout of old
// rows does not divide by a window the agent has since changed. The
// index serves the lookup by session.

import type { Migration } from "../migration.ts";

export const m0002: Migration = {
  id: "0002-usage-seq",
  up(db) {
    db.exec(`
      alter table usage add column seq integer not null default 0;
      alter table usage add column context_length integer;
      update usage set seq = (
        select count(*) from usage as earlier
        where earlier.session_id = usage.session_id
          and (earlier.created_at < usage.created_at
            or (earlier.created_at = usage.created_at
              and earlier.rowid <= usage.rowid))
      );
      create index usage_session on usage(session_id, seq);
    `);
  },
};
