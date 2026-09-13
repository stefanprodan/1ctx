// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool loop's rows. messages gains the send it belongs to, the
// provider round, the server's slot ("work" inside the fold, "answer"
// in the main column) and the tool columns; the kind check widens to
// take a tool row, which SQLite can only do by rebuilding the table
// (create, copy, drop, rename, the SQLite way). This is the pattern for
// widening a check from now on. sends gains its round and call
// counters, and usage gains one row per (send, round). The preview db
// keeps its rows: every message is placed in the send its user message
// started, found by sends.first_message_id, and a row that matches no
// send fails the migration rather than lose its place.
//
// The old defaults, foreign keys, cascade and unique (session_id, seq)
// are recreated verbatim on the rebuilt messages table.

import type { Migration } from "../migration.ts";

export const m0003: Migration = {
  id: "0003-tools",
  up(db) {
    // a message that landed in no send would lose its place on the
    // rebuild; alpha rewrites rather than orphan, so refuse the
    // migration before the copy rather than let the not-null insert
    // fail with a constraint the reader cannot read
    const orphans = db
      .query<{ n: number }, []>(
        `select count(*) as n from messages as m
         where not exists (
           select 1 from sends as s
           where s.session_id = m.session_id
             and s.first_message_id = (
               select u.id from messages as u
               where u.session_id = m.session_id
                 and u.kind = 'user' and u.seq <= m.seq
               order by u.seq desc
               limit 1
             )
         )`,
      )
      .get()!.n;
    if (orphans > 0) {
      throw new Error(`0003-tools: ${orphans} messages matched no send`);
    }
    db.exec(`
      alter table sends add column rounds integer not null default 1;
      alter table sends add column tool_calls integer not null default 0;

      create table messages_new (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        seq integer not null,
        kind text not null check (kind in ('user', 'reply', 'tool')),
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
        -- a non-reply row shows nowhere by slot and asks for no calls
        check (kind = 'reply' or (slot is null and tool_calls is null)),
        -- a tool row names its call and tool; every other row names
        -- neither
        check (
          (kind = 'tool') = (tool_call_id is not null)
          and (kind = 'tool') = (tool_name is not null)
        ),
        -- a reply that has stopped streaming has been placed
        check (kind <> 'reply' or status = 'streaming' or slot is not null)
      );

      -- the send each message belongs to: the send whose user message
      -- (sends.first_message_id) has the greatest seq at or before this
      -- row, within the session. round is 1 for every backfilled row; a
      -- finished reply is the answer, a streaming one is unplaced, a
      -- non-reply row has no slot.
      insert into messages_new (
        id, session_id, seq, kind, send_id, round, slot, user_id, agent_id,
        content, reasoning, html, status, error, finish_reason,
        reasoning_details, tool_calls, tool_call_id, tool_name, model,
        ttft_ms, thinking_ms, created_at, finished_at
      )
      select
        m.id, m.session_id, m.seq, m.kind,
        (
          select s.id from sends as s
          where s.session_id = m.session_id
            and s.first_message_id = (
              select u.id from messages as u
              where u.session_id = m.session_id
                and u.kind = 'user' and u.seq <= m.seq
              order by u.seq desc
              limit 1
            )
          limit 1
        ) as send_id,
        1 as round,
        case
          when m.kind = 'reply' and m.status <> 'streaming' then 'answer'
          else null
        end as slot,
        m.user_id, m.agent_id, m.content, m.reasoning, m.html, m.status,
        m.error, m.finish_reason, m.reasoning_details, null, null, null,
        m.model, m.ttft_ms, m.thinking_ms, m.created_at, m.finished_at
      from messages as m;

      drop table messages;
      alter table messages_new rename to messages;

      create unique index messages_answer
        on messages(send_id) where slot = 'answer';
      create unique index messages_streaming_reply
        on messages(send_id) where kind = 'reply' and status = 'streaming';

      create unique index usage_send_round on usage(send_id, round);
    `);
    const violations = db.query("pragma foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `0003-tools: foreign key check found ${violations.length} violations`,
      );
    }
  },
};
