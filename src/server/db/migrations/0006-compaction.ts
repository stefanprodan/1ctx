// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Compaction widens the messages and sends kind checks. Both tables are
// rebuilt together so messages can keep their send references while the
// parent table is replaced. Every existing column, default, foreign key,
// cascade, unique and check is recreated verbatim.

import type { Migration } from "../migration.ts";

export const m0006: Migration = {
  id: "0006-compaction",
  up(db) {
    db.exec(`
      create table sends_new (
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
        started_at integer not null,
        finished_at integer,
        rounds integer not null default 1,
        tool_calls integer not null default 0
      );

      insert into sends_new (
        id, session_id, kind, user_id, agent_id, provider_id, model, status,
        cause, error, first_message_id, started_at, finished_at, rounds,
        tool_calls
      )
      select
        id, session_id, kind, user_id, agent_id, provider_id, model, status,
        cause, error, first_message_id, started_at, finished_at, rounds,
        tool_calls
      from sends;

      create table messages_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        seq integer not null,
        kind text not null
          check (kind in ('user', 'reply', 'tool', 'summary')),
        send_id text not null references sends_new(id),
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

      insert into messages_new (
        id, session_id, seq, kind, send_id, round, slot, user_id, agent_id,
        content, reasoning, html, status, error, finish_reason,
        reasoning_details, tool_calls, tool_call_id, tool_name, model,
        ttft_ms, thinking_ms, created_at, finished_at
      )
      select
        id, session_id, seq, kind, send_id, round, slot, user_id, agent_id,
        content, reasoning, html, status, error, finish_reason,
        reasoning_details, tool_calls, tool_call_id, tool_name, model,
        ttft_ms, thinking_ms, created_at, finished_at
      from messages;

      drop table messages;
      drop table sends;
      alter table sends_new rename to sends;
      alter table messages_new rename to messages;

      create index sends_session on sends(session_id, started_at);
      create unique index messages_answer
        on messages(send_id) where slot = 'answer';
      create unique index messages_streaming_reply
        on messages(send_id) where kind = 'reply' and status = 'streaming';
    `);
    const violations = db.query("pragma foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `0006-compaction: foreign key check found ${violations.length} violations`,
      );
    }
  },
};
