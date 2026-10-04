// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's own mark, its agent's or the runner's: sure, with a reason,
// written in the transaction that ends the run, so the run's one
// envelope carries it.

import type { Db } from "../db/index.ts";

// the agent's mark names the agent; the runner's names nobody
export type RunMark = {
  reason: string;
  source: "agent" | "runner";
  by: string | null;
};

export function markRun(db: Db, sessionId: string, mark: RunMark): void {
  db.query(
    `update sessions set attention = 1, attention_by = ?,
       attention_reason = ?, attention_source = ?
     where id = ?`,
  ).run(mark.by, mark.reason, mark.source, sessionId);
}
