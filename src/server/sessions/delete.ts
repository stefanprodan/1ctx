// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { type DeletedRun, deletedRun } from "./alerts.ts";
import type { UsagePort } from "./rows.ts";
import { runPostsUnlinked } from "./run-post.ts";

export type SessionDeleted = {
  type: "session.deleted";
  data: { projectId: string; sessionId: string };
};

// its usage rows stay; "running" when a send holds it, null when gone
function deleteSession(db: Db, id: string): SessionDeleted | "running" | null {
  const row = db
    .query<{ project_id: string; status: string }, [string]>(
      "select project_id, status from sessions where id = ?",
    )
    .get(id);
  if (row === null) return null;
  if (row.status === "running") return "running";
  db.query("delete from sessions where id = ?").run(id);
  return {
    type: "session.deleted",
    data: { projectId: row.project_id, sessionId: id },
  };
}

export type Pruned = (run: DeletedRun) => BusEvent[];

// a marked run's delete updates its automation's open alert, and one
// the row names moves its revision, so a client drops the link; so does
// a channel whose post links it
export function removeSession(
  db: Db,
  id: string,
  pruned: Pruned,
  usage: UsagePort,
): SessionDeleted | "running" | null {
  return transact<SessionDeleted | "running" | null>(db, () => {
    const run = deletedRun(db, id);
    const unlinked = runPostsUnlinked(db, usage, { sessionId: id });
    const deleted = deleteSession(db, id);
    if (deleted === null || deleted === "running") {
      return { result: deleted, events: [] };
    }
    const events =
      run === null || (!run.marked && !run.named) ? [] : pruned(run);
    return { result: deleted, events: [...events, ...unlinked()] };
  });
}
