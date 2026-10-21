// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Channels and posts widen the two central tables. Both are referenced,
// so the rebuild keeps every key while foreign keys are held off.
export const m0070: Migration = {
  id: "0070-project-channels",
  rebuild: true,
  rebuilds: ["sessions", "sends"],
  up(db) {
    db.exec(`
      create temp table workspace_counts as
        select id as workspace_id, id as session_id, mcp_folders
        from sessions where mcp_folders > 0;

      create table sessions_new (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        owner_id text references users(id),
        agent_id text references agents(id),
        origin text not null
          check (origin in ('chat', 'automation', 'channel')),
        automation_id text references automations(id) on delete set null,
        title text not null,
        status text not null
          check (status in ('running', 'done', 'failed', 'stopped')),
        revision integer not null default 0,
        created_at integer not null,
        last_activity_at integer not null,
        run_source text
          check (run_source in ('schedule', 'manual', 'restart')),
        forked_from_session_id text,
        forked_from_message_id text,
        disabled_capabilities text not null default '[]',
        archived_at integer,
        archived_by text references users(id) on delete set null,
        archived_reason text
          check (archived_reason in ('manual', 'agent', 'idle')),
        attention real,
        attention_by text,
        attention_reason text,
        attention_source text
          check (attention_source in ('agent', 'runner', 'decider')),
        parent_session_id text references sessions(id) on delete cascade,
        parent_message_id text references messages(id) on delete cascade
          check ((parent_message_id is null) = (parent_session_id is null)),
        dropped_seq integer check (dropped_seq is null or dropped_seq > 0),
        check ((archived_at is null) = (archived_reason is null)),
        check (archived_by is null or archived_reason is 'manual'),
        check (
          (origin = 'channel' and parent_session_id is null) =
            (owner_id is null)
        ),
        check (
          (origin = 'channel' and parent_session_id is null) =
            (agent_id is null)
        )
      );
      insert into sessions_new
        (id, project_id, owner_id, agent_id, origin, automation_id, title,
         status, revision, created_at, last_activity_at, run_source,
         forked_from_session_id, forked_from_message_id,
         disabled_capabilities, archived_at, archived_by,
         archived_reason, attention, attention_by, attention_reason,
         attention_source, parent_session_id, parent_message_id)
      select id, project_id, owner_id, agent_id, origin, automation_id, title,
        status, revision, created_at, last_activity_at, run_source,
        forked_from_session_id, forked_from_message_id,
        disabled_capabilities, archived_at, archived_by,
        archived_reason, attention, attention_by, attention_reason,
        attention_source, parent_session_id, parent_message_id
      from sessions;
      drop table sessions;
      alter table sessions_new rename to sessions;
      create index sessions_agent on sessions(agent_id);
      create index sessions_owner
        on sessions(owner_id, origin, created_at);
      create index sessions_idle on sessions(last_activity_at)
        where origin = 'chat' and archived_at is null
          and parent_session_id is null;
      create index sessions_feed
        on sessions(project_id, origin, (status = 'running') desc,
          last_activity_at desc, id, title)
        where origin = 'automation' and parent_session_id is null;
      create index sessions_feed_chats
        on sessions(project_id, (status = 'running') desc,
          last_activity_at desc, id, title)
        where origin in ('chat', 'channel') and parent_session_id is null;
      create index sessions_feed_unowned
        on sessions(project_id, (status = 'running') desc,
          last_activity_at desc, id, title)
        where automation_id is null and parent_session_id is null;
      create index sessions_automation
        on sessions(automation_id, last_activity_at, id desc, title)
        where automation_id is not null;
      create index sessions_orphan_runs on sessions(last_activity_at)
        where origin = 'automation' and automation_id is null
          and parent_session_id is null;
      create index sessions_marked
        on sessions(automation_id, last_activity_at, id desc, attention)
        where attention >= 0.5;
      create index sessions_children on sessions(parent_session_id)
        where parent_session_id is not null;
      create unique index sessions_parent_message
        on sessions(parent_message_id)
        where parent_message_id is not null;
      create index sessions_activity
        on sessions(project_id, last_activity_at desc, id);
      create unique index sessions_channel on sessions(project_id)
        where origin = 'channel' and parent_session_id is null;

      create table session_workspaces (
        workspace_id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        mcp_folders integer not null default 0
      );
      create index session_workspaces_session
        on session_workspaces(session_id);
      insert into session_workspaces
        (workspace_id, session_id, mcp_folders)
      select workspace_id, session_id, mcp_folders from workspace_counts;
      drop table workspace_counts;

      create table sends_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null check (kind in ('chat', 'compact', 'run', 'post')),
        user_id text not null references users(id),
        agent_id text references agents(id),
        provider_id text,
        provider_name text,
        model text,
        status text not null
          check (status in ('running', 'done', 'failed', 'stopped')),
        cause text,
        error text,
        first_message_id text not null,
        rounds integer not null default 1,
        tool_calls integer not null default 0,
        started_at integer not null,
        finished_at integer,
        mcp text,
        memory_round integer,
        memory_error text,
        memory_skipped integer,
        summoned integer not null default 0 check (summoned in (0, 1)),
        attention_round integer,
        memory_from integer,
        child integer not null default 0 check (child in (0, 1)),
        check (agent_id is not null or kind = 'post'),
        check ((kind = 'post') = (provider_id is null)),
        check ((kind = 'post') = (provider_name is null)),
        check ((kind = 'post') = (model is null))
      );
      insert into sends_new
        (id, session_id, kind, user_id, agent_id, provider_id,
         provider_name, model, status, cause, error, first_message_id,
         rounds, tool_calls, started_at, finished_at, mcp, memory_round,
         memory_error, memory_skipped, summoned, attention_round,
         memory_from, child)
      select id, session_id, kind, user_id, agent_id, provider_id,
        provider_name, model, status, cause, error, first_message_id,
        rounds, tool_calls, started_at, finished_at, mcp, memory_round,
        memory_error, memory_skipped, summoned, attention_round,
        memory_from, child
      from sends;
      drop table sends;
      alter table sends_new rename to sends;
      create index sends_session on sends(session_id, started_at);
      create index sends_agent on sends(agent_id, started_at, child);
      create index sends_running on sends(agent_id) where status = 'running';
      create index sends_started on sends(started_at);
    `);
  },
};
