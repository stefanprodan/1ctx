// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { readDrafts } from "./draft-read.ts";

export function draftChanged(db: Db, id: string): BusEvent {
  return {
    type: "draft.changed",
    data: readDrafts(db, "id", id)[0]!,
  };
}

export function draftsRemoved(
  db: Db,
  sessionId: string,
  ids: string[],
): BusEvent[] {
  if (ids.length === 0) return [];
  const project = db
    .query<{ projectId: string }, [string]>(
      "select project_id as projectId from sessions where id = ?",
    )
    .get(sessionId)!;
  return ids.map((draftId) => ({
    type: "draft.changed",
    data: {
      projectId: project.projectId,
      sessionId,
      draftId,
      removed: true,
    },
  }));
}
