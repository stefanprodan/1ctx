// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one delete of a chat or a run, for the delete route, a task's
// retention and the chats sweep. The foreign keys take its sends,
// messages, opened and kept MCP files, scratch, uploads and memory
// views, and null the memory notes' and automations' pointers to it.
// Its usage rows stay: they are the record of what was spent.

import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { markedRun } from "./alerts.ts";

export type SessionDeleted = {
  type: "session.deleted";
  data: { projectId: string; sessionId: string };
};

// in the caller's transaction: the event to publish, "running" when a
// send holds it, null when it is gone already
export function deleteSession(
  db: Db,
  id: string,
): SessionDeleted | "running" | null {
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

// a marked run's delete, with when the run ended, over its automation's
// open alert: the events to publish
export type Pruned = (automationId: string, endedAt: number) => BusEvent[];

// the delete with what it leaves of its automation's open alert: a
// marked run's delete tells the automations area, through pruned, which
// closes an alert with no run left or counts one run fewer, its events
// published with the caller's transaction
export function removeSession(
  db: Db,
  id: string,
  pruned: Pruned,
): SessionDeleted | "running" | null {
  return transact(db, () => {
    const marked = markedRun(db, id);
    const deleted = deleteSession(db, id);
    const events =
      marked === null || deleted === null || deleted === "running"
        ? []
        : pruned(marked.automationId, marked.endedAt);
    return { result: deleted, events };
  });
}
