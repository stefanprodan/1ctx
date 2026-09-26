// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A deleted agent is retired, not removed: its sessions, sends,
// messages and usage keep pointing at it. A retired row holds no
// provider and frees its name, so the name is unique among live agents
// only. sends keep the provider's name and drop the key, so a provider
// that served chats can be deleted. A chat is archived for good, by
// hand, by its agent's delete or after idle days; an archived chat's
// and an ended run's large tool results are stored compressed.
export const m0030: Migration = {
  id: "0030-archived-chats",
  rebuild: true,
  up(db) {
    db.exec(`
      create table agents_new (
        id text primary key,
        name text not null,
        avatar text not null default 'bot',
        provider_id text references providers(id),
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
        created_at integer not null,
        mcp_mode text not null default 'auto'
          check (mcp_mode in ('all', 'catalog', 'auto')),
        model_described integer not null default 1
          check (model_described in (0, 1)),
        thinking_required integer not null default 0,
        reasoning_known integer not null default 0,
        upstream text,
        is_default integer not null default 0,
        deleted_at integer,
        check ((deleted_at is null) = (provider_id is not null)),
        check (deleted_at is null or is_default = 0)
      );
      insert into agents_new
        (id, name, avatar, provider_id, model, model_name, context_length,
         prompt_price, completion_price, tools, reasoning, prompt, thinking,
         effort, created_at, mcp_mode, model_described, thinking_required,
         reasoning_known, upstream, is_default)
      select id, name, avatar, provider_id, model, model_name, context_length,
        prompt_price, completion_price, tools, reasoning, prompt, thinking,
        effort, created_at, mcp_mode, model_described, thinking_required,
        reasoning_known, upstream, is_default
      from agents;
      drop table agents;
      alter table agents_new rename to agents;
      create index agents_provider on agents(provider_id);
      create unique index agents_default on agents(is_default)
        where is_default = 1;
      create unique index agents_name on agents(name)
        where deleted_at is null;

      create table sends_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null check (kind in ('chat', 'compact', 'run')),
        user_id text not null references users(id),
        agent_id text not null references agents(id),
        provider_id text not null,
        provider_name text not null,
        model text not null,
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
        memory_skipped integer
      );
      insert into sends_new
        (id, session_id, kind, user_id, agent_id, provider_id,
         provider_name, model, status, cause, error, first_message_id,
         rounds, tool_calls, started_at, finished_at, mcp, memory_round,
         memory_error, memory_skipped)
      select s.id, s.session_id, s.kind, s.user_id, s.agent_id,
        s.provider_id, coalesce(p.name, s.provider_id), s.model, s.status,
        s.cause, s.error, s.first_message_id, s.rounds, s.tool_calls,
        s.started_at, s.finished_at, s.mcp, s.memory_round, s.memory_error,
        s.memory_skipped
      from sends s left join providers p on p.id = s.provider_id;
      drop table sends;
      alter table sends_new rename to sends;
      create index sends_session on sends(session_id, started_at);

      alter table sessions add column archived_at integer;
      alter table sessions add column archived_by text
        references users(id) on delete set null;
      alter table sessions add column archived_reason text
        check (archived_reason in ('manual', 'agent', 'idle'))
        check ((archived_at is null) = (archived_reason is null))
        check (archived_by is null or archived_reason is 'manual');
      create index sessions_idle on sessions(last_activity_at)
        where origin = 'chat' and archived_at is null;

      alter table messages add column packed blob;
      alter table messages add column packed_bytes integer
        check ((packed is null) = (packed_bytes is null))
        check (packed is null or (kind = 'tool' and content = ''));
      create index messages_send on messages(send_id);
      -- the sweep's packable scan; PACKABLE in sessions/pack.ts matches
      create index messages_packable on messages(session_id)
        where kind = 'tool' and packed is null
          and status in ('done', 'stopped')
          and octet_length(content) >= 1024;
    `);
  },
};
