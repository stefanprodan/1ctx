// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A decider is a decision model an admin names: a provider and a model
// that answer typed questions. At most one is marked the default, else
// the oldest is. Every answered decision is counted apart from the
// model rounds, with the names kept as text so it outlives its decider
// and provider. A decision keeps a row only once an admin saves it, and
// an option only while its text differs from the one in code; a
// decider deleted leaves its decisions on the default. A finished run
// keeps the chance that it needs a person and the decider that said so.
export const m0031: Migration = {
  id: "0031-deciders",
  up(db) {
    db.exec(`
      create table deciders (
        id text primary key,
        name text not null unique,
        provider_id text not null references providers(id),
        model text not null,
        context_length integer,
        prompt_price real,
        is_default integer not null default 0,
        created_at integer not null
      );
      create index deciders_provider on deciders(provider_id);
      create unique index deciders_default on deciders(is_default)
        where is_default = 1;

      create table decisions (
        id text primary key,
        enabled integer not null,
        decider_id text references deciders(id) on delete set null,
        updated_at integer not null
      );
      create index decisions_decider on decisions(decider_id);

      create table decision_options (
        decision_id text not null references decisions(id)
          on delete cascade,
        option text not null,
        description text not null,
        primary key (decision_id, option)
      );

      create table decision_usage (
        id text primary key,
        decider_id text not null,
        decider_name text not null,
        provider_id text not null,
        provider_name text not null,
        model text not null,
        purpose text not null,
        session_id text,
        project_id text,
        input_tokens integer,
        output_tokens integer,
        cost real,
        duration integer not null,
        created_at integer not null
      );
      create index decision_usage_created on decision_usage(created_at);

      alter table sessions add column attention real;
      alter table sessions add column attention_by text;
    `);
  },
};
