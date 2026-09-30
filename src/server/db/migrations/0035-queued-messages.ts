// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A message sent while its chat's turn runs waits here, never in
// messages, until the dispatcher starts it or it is not sent. The
// reasons are NOT_SENT_REASONS in shared/words.ts, frozen here.
export const m0035: Migration = {
  id: "0035-queued-messages",
  up(db) {
    db.exec(`
      create table queued_messages (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        author_id text not null references users(id) on delete cascade,
        content text not null,
        uploads text,
        capabilities text,
        state text not null default 'queued'
          check (state in ('queued', 'not-sent')),
        reason text
          check (reason in ('expired', 'archived', 'agent-deleted', 'failed'))
          check ((state = 'queued') = (reason is null)),
        revision integer not null default 0,
        queued_at integer not null,
        changed_at integer not null
      );
      -- the chat's rows: the detail, its count and the rows a start takes
      create index queued_session on queued_messages(session_id, state, queued_at);
      -- a user's rows: their count and Home's not-sent list
      create index queued_author on queued_messages(author_id, state, changed_at);
      -- the waiting rows by age: the dispatcher's page, expiry and load
      create index queued_waiting on queued_messages(queued_at, session_id)
        where state = 'queued';
      -- the not-sent rows by age: the sweep and load
      create index queued_not_sent on queued_messages(changed_at)
        where state = 'not-sent';
    `);
  },
};
