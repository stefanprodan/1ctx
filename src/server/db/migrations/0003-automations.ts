// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0003: Migration = {
  id: "0003-automations",
  rebuild: true,
  up(db) {
    db.exec(`
      create table automations (
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
          check (last_event_source in ('schedule', 'manual')),
        last_event_outcome text
          check (last_event_outcome in ('run', 'skipped')),
        last_event_reason text,
        last_run_session_id text references sessions(id) on delete set null,
        last_run_status text
          check (last_run_status in ('running', 'done', 'failed', 'stopped')),
        revision integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        unique (project_id, name),
        check ((suspended_at is null) = (next_at is not null))
      );
      create index automations_due
        on automations(next_at) where suspended_at is null;

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
        last_activity_at integer not null
      );
      insert into sessions_new
        (id, project_id, owner_id, agent_id, origin, automation_id, title,
         status, revision, created_at, last_activity_at)
      select id, project_id, owner_id, agent_id, origin, null, title,
             status, revision, created_at, last_activity_at
        from sessions;
      drop table sessions;
      alter table sessions_new rename to sessions;
      create index sessions_project
        on sessions(project_id, last_activity_at);
      create index sessions_agent on sessions(agent_id);
      create index sessions_automation
        on sessions(automation_id, last_activity_at);

      create table sends_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null check (kind in ('chat', 'compact', 'run')),
        user_id text not null references users(id),
        agent_id text not null references agents(id),
        provider_id text not null references providers(id),
        model text not null,
        status text not null
          check (status in ('running', 'done', 'failed', 'stopped')),
        cause text,
        error text,
        first_message_id text not null,
        rounds integer not null default 1,
        tool_calls integer not null default 0,
        started_at integer not null,
        finished_at integer
      );
      insert into sends_new
        (id, session_id, kind, user_id, agent_id, provider_id, model, status,
         cause, error, first_message_id, rounds, tool_calls, started_at,
         finished_at)
      select id, session_id, kind, user_id, agent_id, provider_id, model,
             status, cause, error, first_message_id, rounds, tool_calls,
             started_at, finished_at
        from sends;
      drop table sends;
      alter table sends_new rename to sends;
      create index sends_session on sends(session_id, started_at);
    `);
  },
};
