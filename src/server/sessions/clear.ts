// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin's clear of a channel: every message and send goes, and what
// hangs off them, while the channel row, its usage, its runs and the
// project's memory and knowledge stay. Messages go before sends, since
// messages.send_id has no on delete; pending turns, opened and kept
// files, images and child sessions cascade from the messages, memory
// views from the sends.

import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { Conflict } from "../lib/errors.ts";
import type { DraftsPort } from "./drafts.ts";
import { queueChanged } from "./queued.ts";
import type { SessionStore } from "./store.ts";
import type { SweepScratch } from "./sweep.ts";

export type ClearDeps = {
  db: Db;
  store: SessionStore;
  scratch: SweepScratch;
  uploads: { clearUploads(sessionId: string): void };
  drafts?: Pick<DraftsPort, "removePending">;
};

// in the caller's transaction, which has checked that no turn runs; a
// command still held in an agent's workspace refuses it as a turn does
export function clearChannel(
  deps: ClearDeps,
  sessionId: string,
  now: number,
): BusEvent[] {
  const { db, store } = deps;
  const prefix = `${sessionId}:`;
  for (const id of deps.scratch.held()) {
    if (id === sessionId || id.startsWith(prefix)) {
      throw new Conflict("a turn is running");
    }
  }
  const sendIds = db
    .query<{ id: string }, [string]>(
      "select id from sends where session_id = ?",
    )
    .all(sessionId)
    .map((row) => row.id);
  deps.drafts?.removePending(sessionId, sendIds);
  deps.uploads.clearUploads(sessionId);
  db.query("delete from messages where session_id = ?").run(sessionId);
  db.query("delete from sends where session_id = ?").run(sessionId);
  // every agent's workspace of the channel: its session_id is the channel
  deps.scratch.drop(sessionId);
  // past the last clear even within one millisecond, so every clear is
  // a new mark a tab can compare
  db.query(
    `update sessions set dropped_seq = null,
       cleared_at = max(?, coalesce(cleared_at, 0) + 1)
     where id = ?`,
  ).run(now, sessionId);
  // moves the revision, and the pending list every watcher holds empties
  const queue = queueChanged(db, sessionId, { shared: true });
  const session = store.byId(sessionId);
  if (session === null) return queue;
  return [
    {
      type: "session.changed",
      data: {
        projectId: session.projectId,
        session,
        messages: [],
        send: null,
        cleared: true,
      },
    },
    ...queue,
  ];
}
