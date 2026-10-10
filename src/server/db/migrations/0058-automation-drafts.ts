// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0058: Migration = {
  id: "0058-automation-drafts",
  up(db) {
    db.exec(`
      create table automation_drafts (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        send_id text not null,
        message_id text not null,
        user_id text not null,
        agent_id text not null,
        action text not null check (action in
          ('create', 'update', 'suspend', 'resume', 'run')),
        automation_id text,
        edit_revision integer,
        fields text not null,
        state text not null check (state in
          ('pending', 'confirmed', 'dismissed', 'stale', 'expired')),
        decided_by text,
        decided_at integer,
        created_automation_id text,
        run_session_id text,
        created_at integer not null,
        expires_at integer not null
      );
      create index automation_drafts_session
        on automation_drafts(session_id, created_at, id);
      create index automation_drafts_pending_session
        on automation_drafts(session_id, send_id) where state = 'pending';
      create index automation_drafts_expiry
        on automation_drafts(expires_at, id) where state = 'pending';
    `);
  },
};
