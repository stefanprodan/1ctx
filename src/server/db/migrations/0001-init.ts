// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// 1ctx has no release, so the schema's history is folded into this one
// migration. logins hold a hash of the token, so a database read never
// yields a usable cookie. usage carries no foreign key, so a usage row
// outlives the chat it counted.
export const m0001: Migration = {
  id: "0001-init",
  up(db) {
    db.exec(`
      create table users (
        id text primary key,
        username text not null unique,
        full_name text not null,
        email text not null,
        about text not null default '',
        role text not null check (role in ('admin', 'member')),
        password_hash text not null,
        disabled integer not null default 0,
        must_change_password integer not null default 0,
        created_at integer not null
      );
      create unique index users_email on users(email);

      create table logins (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        token_hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null,
        expires_at integer not null
      );
      create index logins_user on logins(user_id);

      create table projects (
        id text primary key,
        kind text not null check (kind in ('personal', 'team')),
        name text not null,
        description text not null default '',
        owner_id text not null references users(id) on delete cascade,
        created_at integer not null,
        check ((kind = 'personal') = (name = 'personal'))
      );
      create unique index projects_personal
        on projects(owner_id) where kind = 'personal';
      create unique index projects_team_name
        on projects(name) where kind = 'team';

      create table memberships (
        project_id text not null references projects(id) on delete cascade,
        user_id text not null references users(id) on delete cascade,
        created_at integer not null,
        primary key (project_id, user_id)
      );
      create index memberships_user on memberships(user_id);

      create table providers (
        id text primary key,
        name text not null unique,
        wire text not null check (wire in ('openrouter', 'openai-compatible')),
        base_url text not null,
        key_name text,
        created_at integer not null
      );

      create table agents (
        id text primary key,
        name text not null unique,
        avatar text not null default 'bot',
        provider_id text not null references providers(id),
        model text not null,
        model_name text not null,
        context_length integer,
        prompt_price real,
        completion_price real,
        tools integer not null default 0,
        reasoning integer not null default 0,
        prompt text not null default '',
        thinking text check (thinking in ('on', 'off')),
        effort text
          check (effort in ('minimal', 'low', 'medium', 'high', 'xhigh')),
        created_at integer not null
      );
      create index agents_provider on agents(provider_id);

      create table sessions (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        owner_id text not null references users(id),
        agent_id text not null references agents(id),
        origin text not null check (origin in ('chat')),
        title text not null,
        status text not null
          check (status in ('running', 'done', 'failed', 'stopped')),
        revision integer not null default 0,
        created_at integer not null,
        last_activity_at integer not null
      );
      create index sessions_project on sessions(project_id, last_activity_at);
      create index sessions_agent on sessions(agent_id);

      create table sends (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null check (kind in ('chat', 'compact')),
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
      create index sends_session on sends(session_id, started_at);

      create table messages (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        seq integer not null,
        kind text not null
          check (kind in ('user', 'reply', 'tool', 'summary')),
        send_id text not null references sends(id),
        round integer not null check (round >= 1),
        slot text check (slot in ('work', 'answer')),
        user_id text references users(id),
        agent_id text references agents(id),
        content text not null default '',
        reasoning text not null default '',
        html text not null default '',
        status text not null
          check (status in ('streaming', 'done', 'failed', 'stopped')),
        error text,
        finish_reason text,
        reasoning_details text,
        tool_calls text,
        tool_call_id text,
        tool_name text,
        model text,
        ttft_ms integer,
        thinking_ms integer,
        created_at integer not null,
        finished_at integer,
        unique (session_id, seq),
        check (kind = 'reply' or (slot is null and tool_calls is null)),
        check (
          (kind = 'tool') = (tool_call_id is not null)
          and (kind = 'tool') = (tool_name is not null)
        ),
        check (kind <> 'reply' or status = 'streaming' or slot is not null)
      );
      create unique index messages_answer
        on messages(send_id) where slot = 'answer';
      create unique index messages_streaming_reply
        on messages(send_id) where kind = 'reply' and status = 'streaming';

      create table usage (
        id text primary key,
        send_id text not null,
        session_id text not null,
        project_id text not null,
        user_id text not null,
        agent_id text not null,
        provider_id text not null,
        model text not null,
        round integer not null,
        seq integer not null,
        prompt_tokens integer not null,
        completion_tokens integer not null,
        cached_tokens integer,
        reasoning_tokens integer,
        cost real,
        context_length integer,
        created_at integer not null
      );
      create index usage_project on usage(project_id, created_at);
      create index usage_session on usage(session_id, seq);
      create unique index usage_send_round on usage(send_id, round);

      create table tools (
        name text primary key
          check (name in ('datetime', 'webfetch', 'websearch')),
        enabled integer not null default 1 check (enabled in (0, 1)),
        provider text check (provider in ('exa', 'firecrawl')),
        updated_at integer not null
      );
      -- migrations get no clock, so the rows start at zero
      insert into tools (name, enabled, provider, updated_at) values
        ('datetime', 1, null, 0),
        ('webfetch', 1, null, 0),
        ('websearch', 1, null, 0);

      create table limits (
        name text primary key,
        value integer not null,
        updated_at integer not null
      );
    `);
  },
};
