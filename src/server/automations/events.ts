// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import { type Db, transact } from "../db/index.ts";
import { errorFields, type Log } from "../lib/log.ts";
import {
  type AutomationStore,
  automationChanged,
  type EventFields,
} from "./store.ts";

export type RecordDeps = { db: Db; store: AutomationStore; log: Log };

// one event on a row that is active and due, in its own transaction, the
// row read again inside it; pick answers null to write nothing. True
// when written; a failure is logged as failed
export function recordOn(
  deps: RecordDeps,
  id: string,
  failed: string,
  pick: (row: AutomationSummary, dueAt: number) => EventFields | null,
): boolean {
  try {
    return transact(deps.db, () => {
      const row = deps.store.byId(id);
      if (row === null || row.suspendedAt !== null || row.nextAt === null) {
        return { result: false };
      }
      const fields = pick(row, row.nextAt);
      if (fields === null) return { result: false };
      const updated = deps.store.recordEvent(row.id, fields)!;
      return { result: true, events: [automationChanged(updated)] };
    });
  } catch (err) {
    deps.log.error(failed, { automation: id, ...errorFields(err) });
    return false;
  }
}
