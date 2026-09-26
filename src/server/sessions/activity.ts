// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a person did per day, for their page: the messages they wrote
// in chats, the chats they started and the runs they started by hand.
// A fork's copied messages keep the instant they were first written,
// before the fork was made, so only a message no older than its chat
// is theirs to count there. A run's instructions are a user message
// too, which the chat origin leaves out.

import type { Db } from "../db/index.ts";
import { countByDay } from "../usage/index.ts";

export function personDays(
  db: Db,
  userId: string,
  starts: readonly number[],
  until: number,
): number[] {
  if (starts.length === 0) return [];
  const since = starts[0]!;
  const rows = db
    .query<{ at: number }, [string, number, number, string, number, number]>(
      `select m.created_at as at
         from messages m
         join sessions s on s.id = m.session_id
        where m.user_id = ? and m.kind = 'user'
          and m.created_at >= ? and m.created_at < ?
          and s.origin = 'chat' and m.created_at >= s.created_at
       union all
       select created_at as at
         from sessions
        where owner_id = ?
          and created_at >= ? and created_at < ?
          and (origin = 'chat'
               or (origin = 'automation' and run_source = 'manual'))`,
    )
    .all(userId, since, until, userId, since, until);
  return countByDay(
    starts,
    until,
    rows.map((row) => row.at),
  );
}
