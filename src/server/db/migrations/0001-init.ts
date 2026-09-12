// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// users: identity and the password hash (argon2id, PHC string). logins:
// the row behind a cookie, holding a hash of the token so a database
// read never yields a usable cookie. projects: the container everything
// lives in, personal (one per user, made with the user and gone with
// the user) or team; memberships: who is in a project. providers: where
// the models come from, with the name of the key file, never the key;
// agents: a name, a provider and a model, with what the catalog said
// about the model when it was picked, the avatar and the system prompt.
export const m0001: Migration = {
  id: "0001-init",
  up(db) {
    db.exec(`
      create table users (
        id text primary key,
        username text not null unique,
        full_name text not null,
        about text not null default '',
        role text not null check (role in ('admin', 'member')),
        password_hash text not null,
        created_at integer not null
      );
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
        name text not null unique,
        owner_id text not null references users(id) on delete cascade,
        created_at integer not null
      );
      create unique index projects_personal
        on projects(owner_id) where kind = 'personal';
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
        created_at integer not null
      );
      create index agents_provider on agents(provider_id);
    `);
  },
};
