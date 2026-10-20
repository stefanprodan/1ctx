// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0072: Migration = {
  id: "0072-channel-turns",
  rebuild: true,
  rebuilds: ["memory_views"],
  up(db) {
    db.exec(`
      create table pending_turns (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        message_id text not null unique references messages(id) on delete cascade,
        author_id text not null references users(id) on delete cascade,
        agent_id text not null references agents(id),
        queued_at integer not null,
        changed_at integer not null,
        reason text check (reason in ('expired', 'agent-deleted', 'failed'))
      );
      create index pending_session on pending_turns(session_id, queued_at);
      create index pending_author on pending_turns(author_id);
      create index pending_waiting on pending_turns(queued_at)
        where reason is null;

      create table memory_views_next (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        send_id text unique references sends(id) on delete cascade,
        snapshot text not null,
        seen text not null
      );
      insert into memory_views_next (id, session_id, snapshot, seen)
        select session_id, session_id, snapshot, seen from memory_views;
      drop table memory_views;
      alter table memory_views_next rename to memory_views;
      create unique index memory_chat_view on memory_views(session_id)
        where send_id is null;

      alter table email_outbox add column send_id text;
      create index email_send on email_outbox(send_id, kind)
        where send_id is not null;
      create index sends_channel_running on sends(session_id, agent_id)
        where status = 'running';
    `);
  },
};
