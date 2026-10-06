// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's attention mark from a decider: the chance it gave that the
// outcome needs a person, and which decider said so. The agent's and
// the runner's marks are written with the run's end (marks.ts).

import { type Db, transact } from "../db/index.ts";
import { envelope } from "./envelope.ts";
import type { SessionStore } from "./store.ts";

// the send's last done answer before its memory phase, whose rounds are
// the agent's notes; null when it has none
export function runAnswer(
  db: Db,
  sendId: string,
  memoryRound: number | null,
): string | null {
  const row = db
    .query<{ content: string }, [string, number | null, number | null]>(
      `select content from messages
       where send_id = ? and slot = 'answer' and status = 'done'
         and (? is null or round < ?)
       order by seq desc limit 1`,
    )
    .get(sendId, memoryRound, memoryRound);
  return row?.content ?? null;
}

// the mark is not activity, so the feed's order and cursor stay; false
// when the session is gone
export function markAttention(
  db: Db,
  store: SessionStore,
  sessionId: string,
  attention: number,
  by: string,
): boolean {
  return transact(db, () => {
    const changed = db
      .query(
        `update sessions set attention = ?, attention_by = ?,
           attention_reason = null, attention_source = 'decider',
           revision = revision + 1
         where id = ?`,
      )
      .run(attention, by, sessionId).changes;
    const row = changed > 0 ? store.byId(sessionId) : null;
    return row === null
      ? { result: false, events: [] }
      : {
          result: true,
          events: [envelope(row, [], store.lastSend(sessionId))],
        };
  });
}
