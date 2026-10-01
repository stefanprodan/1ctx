// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A restart is a run source and a deferred fire an event outcome, and
// an automation may ask to run again what a restart cut. Widening the
// checks rebuilds sessions and automations in place, every row kept,
// with the same columns, checks and indexes otherwise.
export const m0039: Migration = {
  id: "0039-restart-runs",
  rebuild: true,
  rebuilds: ["sessions", "automations"],
  up(db) {
    db.exec(`
      create table sessions_new (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        owner_id text not null references users(id),
        agent_id text not null references agents(id),
        origin text not null check (origin in ('chat', 'automation')),
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
        mcp_folders integer not null default 0,
        archived_at integer,
        archived_by text references users(id) on delete set null,
        archived_reason text
          check (archived_reason in ('manual', 'agent', 'idle')),
        attention real,
        attention_by text,
        check ((archived_at is null) = (archived_reason is null)),
        check (archived_by is null or archived_reason is 'manual')
      );
      insert into sessions_new
        (id, project_id, owner_id, agent_id, origin, automation_id, title,
         status, revision, created_at, last_activity_at, run_source,
         forked_from_session_id, forked_from_message_id,
         disabled_capabilities, mcp_folders, archived_at, archived_by,
         archived_reason, attention, attention_by)
      select id, project_id, owner_id, agent_id, origin, automation_id, title,
        status, revision, created_at, last_activity_at, run_source,
        forked_from_session_id, forked_from_message_id,
        disabled_capabilities, mcp_folders, archived_at, archived_by,
        archived_reason, attention, attention_by
      from sessions;
      drop table sessions;
      alter table sessions_new rename to sessions;
      create index sessions_agent on sessions(agent_id);
      create index sessions_owner
        on sessions(owner_id, origin, created_at);
      create index sessions_idle on sessions(last_activity_at)
        where origin = 'chat' and archived_at is null;
      create index sessions_feed
        on sessions(project_id, origin, (status = 'running') desc,
          last_activity_at desc, id, title);
      create index sessions_feed_unowned
        on sessions(project_id, (status = 'running') desc,
          last_activity_at desc, id, title)
        where automation_id is null;
      create index sessions_automation
        on sessions(automation_id, last_activity_at, id desc, title)
        where automation_id is not null;
      create index sessions_orphan_runs on sessions(last_activity_at)
        where origin = 'automation' and automation_id is null;

      create table automations_new (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        owner_id text not null references users(id),
        agent_id text not null references agents(id),
        name text not null,
        instructions text not null,
        schedule text not null,
        tz text not null,
        deadline_ms integer,
        retention_days integer not null,
        suspended_at integer,
        next_at integer,
        last_event_at integer,
        last_event_due_at integer,
        last_event_source text
          check (last_event_source in ('schedule', 'manual', 'restart')),
        last_event_outcome text
          check (last_event_outcome in ('run', 'skipped', 'deferred')),
        last_event_reason text,
        last_run_session_id text references sessions(id) on delete set null,
        last_run_status text
          check (last_run_status in ('running', 'done', 'failed', 'stopped')),
        revision integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        suspended_by text references users(id),
        own_memory integer not null default 0 check (own_memory in (0, 1)),
        memory_guidance text not null default '',
        disabled_capabilities text not null default '[]',
        rerun_on_restart integer not null default 0
          check (rerun_on_restart in (0, 1)),
        unique (project_id, name),
        check ((suspended_at is null) = (next_at is not null))
      );
      insert into automations_new
        (id, project_id, owner_id, agent_id, name, instructions, schedule, tz,
         deadline_ms, retention_days, suspended_at, next_at, last_event_at,
         last_event_due_at, last_event_source, last_event_outcome,
         last_event_reason, last_run_session_id, last_run_status, revision,
         created_at, updated_at, suspended_by, own_memory, memory_guidance,
         disabled_capabilities)
      select id, project_id, owner_id, agent_id, name, instructions, schedule,
        tz, deadline_ms, retention_days, suspended_at, next_at, last_event_at,
        last_event_due_at, last_event_source, last_event_outcome,
        last_event_reason, last_run_session_id, last_run_status, revision,
        created_at, updated_at, suspended_by, own_memory, memory_guidance,
        disabled_capabilities
      from automations;
      drop table automations;
      alter table automations_new rename to automations;
      create index automations_due
        on automations(next_at) where suspended_at is null;
    `);
  },
};
