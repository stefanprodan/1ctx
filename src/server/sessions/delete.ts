// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { markedRun } from "./alerts.ts";

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

export type Pruned = (automationId: string, endedAt: number) => BusEvent[];

// a marked run's delete updates its automation's open alert
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
