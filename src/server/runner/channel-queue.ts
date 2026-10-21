// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { HttpError } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import {
  type PendingCursor,
  type PendingRow,
  queueChanged,
  type SessionStore,
} from "../sessions/index.ts";
import type { PreparedRun } from "./prepare.ts";
import { CapFull, type Registry, waitsForPlace } from "./registry.ts";

export function pendingTurns(deps: {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  registry: Registry;
  limits: { current(): Limits };
  agents: { byId(id: string): unknown | null };
  preparePending(row: PendingRow): PreparedRun;
}) {
  const store = deps.sessions.pending;
  const settle = (
    row: PendingRow,
    reason: NonNullable<PendingRow["reason"]> | "hidden",
  ) => {
    transact(deps.db, () => {
      if (reason === "hidden") store.remove(row.id);
      else store.fail(row.id, reason, deps.clock());
      return {
        result: undefined,
        events: queueChanged(deps.db, row.sessionId, { shared: true }),
      };
    });
    deps.log.info("channel turn not started", { chat: row.sessionId, reason });
  };
  return {
    pass(expireOnly = false, requestedId?: string) {
      let refusal: { error: unknown } | null = null;
      let after: PendingCursor | null = null;
      const busy = new Set<string>();
      const pageSize = 64;
      for (;;) {
        const page = store.waiting(after, pageSize);
        for (const row of page) {
          const key = `${row.sessionId}:${row.agentId}`;
          if (deps.agents.byId(row.agentId) === null) {
            settle(row, "agent-deleted");
          } else if (
            row.queuedAt <=
            deps.clock() - deps.limits.current().queuedMinutes * MINUTE_MS
          ) {
            settle(row, "expired");
          } else if (!expireOnly && !busy.has(key)) {
            busy.add(key);
            try {
              deps.registry.locked(row.sessionId, row.agentId);
              if (
                deps.registry.inSession(row.sessionId).length >=
                deps.limits.current().sendsPerChannel
              ) {
                continue;
              }
              deps.preparePending(row).launch();
              deps.log.info("channel turn started", {
                chat: row.sessionId,
                agent: row.agentId,
              });
            } catch (error) {
              if (waitsForPlace(error)) {
                if (error instanceof CapFull) {
                  if (error.cap === "process") return refusal;
                  if (error.cap === "user") busy.delete(key);
                }
                continue;
              }
              if (row.id === requestedId) refusal = { error };
              settle(
                row,
                error instanceof HttpError && error.status === 404
                  ? "hidden"
                  : "failed",
              );
              deps.log.warn("channel turn start failed", {
                chat: row.sessionId,
                ...errorFields(error),
              });
              // A refused turn must not hold back the next summon.
              busy.delete(key);
            }
          }
        }
        if (page.length < pageSize) return refusal;
        after = page.at(-1)!;
      }
    },
    oldest() {
      const times = [
        deps.sessions.queue.oldestQueuedAt(),
        store.oldestQueuedAt(),
      ].filter((at): at is number => at !== null);
      return times.length === 0 ? null : Math.min(...times);
    },
  };
}
