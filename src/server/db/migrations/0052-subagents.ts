// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An agent may hand a task to a fresh copy of itself once an admin turns
// its switch on; every agent starts off. The copy runs in a child
// session, hidden wherever sessions are listed or counted, linked to its
// root and to the root's tool row that started it, and deleted with
// either. Both links are set together or not at all, one child to a tool
// row, and a column with a reference added in place must default to
// null, so no rebuild.
//
// A child's sends are marked on their own row, which every reader of
// turns already reads, and the agent's walk to its newest send carries
// the mark in its index. The children indexes serve the cascades, which
// look a child up by each link on every delete of a session or a
// message. The feed and sweep indexes are remade partial on roots, so a
// feed walk or a project's count never steps over a child; a project's
// delete then finds its sessions by a scan, which its cascade outweighs.
export const m0052: Migration = {
  id: "0052-subagents",
  up(db) {
    db.exec(`
      alter table agents add column subagents integer not null default 0
        check (subagents in (0, 1));
      alter table sessions add column parent_session_id text
        references sessions(id) on delete cascade;
      alter table sessions add column parent_message_id text
        references messages(id) on delete cascade
        check ((parent_message_id is null) = (parent_session_id is null));
      create index sessions_children on sessions(parent_session_id)
        where parent_session_id is not null;
      create unique index sessions_parent_message
        on sessions(parent_message_id)
        where parent_message_id is not null;
      alter table sends add column child integer not null default 0
        check (child in (0, 1));
      drop index sends_agent;
      create index sends_agent on sends(agent_id, started_at, child);

      drop index sessions_feed;
      create index sessions_feed
        on sessions(project_id, origin, (status = 'running') desc,
          last_activity_at desc, id, title)
        where parent_session_id is null;
      drop index sessions_feed_unowned;
      create index sessions_feed_unowned
        on sessions(project_id, (status = 'running') desc,
          last_activity_at desc, id, title)
        where automation_id is null and parent_session_id is null;
      drop index sessions_idle;
      create index sessions_idle on sessions(last_activity_at)
        where origin = 'chat' and archived_at is null
          and parent_session_id is null;
      drop index sessions_orphan_runs;
      create index sessions_orphan_runs on sessions(last_activity_at)
        where origin = 'automation' and automation_id is null
          and parent_session_id is null;
    `);
  },
};
