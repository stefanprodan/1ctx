// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The opencode wire, and max, the effort it adds. Widening the checks
// rebuilds providers and agents in place, every row kept, with the same
// columns, checks and indexes otherwise.
export const m0042: Migration = {
  id: "0042-opencode",
  rebuild: true,
  rebuilds: ["providers", "agents"],
  up(db) {
    db.exec(`
      create table providers_new (
        id text primary key,
        name text not null unique,
        wire text not null
          check (wire in ('openrouter', 'openai-compatible', 'openai-strict',
            'gemini', 'opencode')),
        base_url text not null,
        key_name text,
        created_at integer not null
      );
      insert into providers_new
        (id, name, wire, base_url, key_name, created_at)
      select id, name, wire, base_url, key_name, created_at from providers;
      drop table providers;
      alter table providers_new rename to providers;

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
          check (effort in
            ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
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
        skip_4bit integer not null default 0 check (skip_4bit in (0, 1)),
        check ((deleted_at is null) = (provider_id is not null)),
        check (deleted_at is null or is_default = 0)
      );
      insert into agents_new
        (id, name, avatar, provider_id, model, model_name, context_length,
         prompt_price, completion_price, tools, reasoning, prompt, thinking,
         effort, created_at, mcp_mode, model_described, thinking_required,
         reasoning_known, upstream, is_default, deleted_at, skip_4bit)
      select id, name, avatar, provider_id, model, model_name, context_length,
        prompt_price, completion_price, tools, reasoning, prompt, thinking,
        effort, created_at, mcp_mode, model_described, thinking_required,
        reasoning_known, upstream, is_default, deleted_at, skip_4bit
      from agents;
      drop table agents;
      alter table agents_new rename to agents;
      create index agents_provider on agents(provider_id);
      create unique index agents_default on agents(is_default)
        where is_default = 1;
      create unique index agents_name on agents(name)
        where deleted_at is null;
    `);
  },
};
