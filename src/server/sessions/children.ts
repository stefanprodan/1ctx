// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A child session is a subagent's: hidden wherever sessions are listed
// or counted, and archived, packed and deleted with its root, never
// alone. Its links never change once written, so a reader that picked a
// root needs no recheck.

import type { Db } from "../db/index.ts";

// a root session, as a condition on sessions; the partial feed and
// sweep indexes repeat it term for term
export const ROOT = "parent_session_id is null";

// every session under the root, nearest first
export function descendants(db: Db, rootId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      `with recursive under(id) as (
         select id from sessions where parent_session_id = ?1
         union all
         select sessions.id from sessions
           join under on sessions.parent_session_id = under.id
       )
       select id from under`,
    )
    .all(rootId)
    .map((row) => row.id);
}
