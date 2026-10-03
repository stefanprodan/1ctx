// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kept MCP files of archived chats and ended runs, packed by a job
// of their own: a chat may keep up to mcpKeptBytes, too much for a click
// or for the synchronous sweep. Small batches, each its own transaction,
// the event loop let run between them. A pass picks its sessions once;
// each batch rechecks its own by key inside its transaction, so what it
// writes ended and is not due for deletion at that moment.

import { KEPT_PACKABLE, type KeptBatch, packKeptBatch } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type Clock, DAY_MS, HOUR_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";

// raw input a batch packs, one file past it alone: 2 MiB blocked for
// 30 ms at p99 on real kept files (4 MiB reached 50), under the 50 ms a
// batch may stall the event loop on a slower pod
export const KEPT_BATCH_BYTES = 2 * 1024 * 1024;

// raw input a pass packs, several times the heavy case's hourly growth
// (about 185 MB); about 4 s of batches at 240 MB/s
export const KEPT_PASS_BYTES = 1024 * 1024 * 1024;

export const KEPT_PASS_MS = HOUR_MS;

// the sessions one batch rechecks; it stops sooner at its bytes
const SESSIONS_PER_BATCH = 64;

export type KeptPackDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  limits: { current(): { archivedDeleteDays: number } };
  // a test's budgets; the constants above by default
  batchBytes?: number;
  passBytes?: number;
};

export type KeptPass = KeptBatch & { batches: number };

export type KeptPacker = {
  // one pass to its end; a call while one runs gets that one
  pass(): Promise<KeptPass>;
  // a pass now, then hourly
  start(): void;
  // no batch starts after it; resolves once a running pass let go
  stop(): Promise<void>;
};

// ended and not due for deletion: a chat archived within
// archivedDeleteDays, an orphaned run inside the same cut (the sweep's),
// a task's run within its retention (the scheduler's); each a >= where
// its deleter has a <
const ELIGIBLE = `sessions.status <> 'running'
  and ((sessions.origin = 'chat' and sessions.archived_at >= ?1)
    or (sessions.origin = 'automation' and sessions.automation_id is null
      and sessions.last_activity_at >= ?1)
    or (sessions.origin = 'automation' and automations.id is not null
      and sessions.last_activity_at >=
        ?2 - automations.retention_days * ${DAY_MS}))`;

// a pass's list, oldest first, of sessions with a file to try; a long
// backlog is picked again once the list is done
export const KEPT_PICK = `select sessions.id as id from sessions
  left join automations on automations.id = sessions.automation_id
  where sessions.id in (select session_id from mcp_kept_files
      where ${KEPT_PACKABLE})
    and ${ELIGIBLE}
  order by sessions.last_activity_at, sessions.id limit ?3`;

// a batch's recheck of one picked session, by its key
export const KEPT_STILL = `select sessions.id as id from sessions
  left join automations on automations.id = sessions.automation_id
  where sessions.id = ?3 and ${ELIGIBLE}`;

// the sessions a pass picks at most at once
const PASS_SESSIONS = 2000;

type Deps = Pick<KeptPackDeps, "db" | "clock" | "limits">;

function cuts(deps: Deps): [number, number] {
  const now = deps.clock();
  return [now - deps.limits.current().archivedDeleteDays * DAY_MS, now];
}

// the sessions a pass works through, oldest first
export function pickKept(deps: Deps, limit = PASS_SESSIONS): string[] {
  return deps.db
    .query<{ id: string }, [number, number, number]>(KEPT_PICK)
    .all(...cuts(deps), limit)
    .map((row) => row.id);
}

/**
 * One batch in its own transaction: the head of the list rechecked by
 * key, what no longer qualifies dropped, the rest packed from the
 * oldest. The sessions it did not finish go back on the list.
 */
export function packKeptOnce(
  deps: Deps,
  list: string[],
  maxBytes: number,
): KeptBatch {
  return transact(deps.db, () => {
    const [cut, now] = cuts(deps);
    const still = deps.db.query<{ id: string }, [number, number, string]>(
      KEPT_STILL,
    );
    const ids: string[] = [];
    while (list.length > 0 && ids.length < SESSIONS_PER_BATCH) {
      const id = list.shift()!;
      if (still.get(cut, now, id) !== null) ids.push(id);
    }
    const { finished, ...batch } = packKeptBatch(deps.db, ids, maxBytes);
    list.unshift(...ids.slice(finished));
    return { result: batch };
  });
}

// a fresh timer task, so requests and sockets run between batches
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function keptPacker(deps: KeptPackDeps): KeptPacker {
  const batchBytes = deps.batchBytes ?? KEPT_BATCH_BYTES;
  const passBytes = deps.passBytes ?? KEPT_PASS_BYTES;
  let stopped = false;
  let running: Promise<KeptPass> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async (): Promise<KeptPass> => {
    const started = performance.now();
    const total: KeptPass = {
      batches: 0,
      files: 0,
      packed: 0,
      refused: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
    try {
      let list: string[] = [];
      // a list that packed nothing is not picked again in the pass
      let pick = true;
      while (!stopped && total.bytesIn < passBytes) {
        if (list.length === 0) {
          if (!pick) break;
          list = pickKept(deps);
          pick = false;
          if (list.length === 0) break;
        }
        const batch = packKeptOnce(
          deps,
          list,
          Math.min(batchBytes, passBytes - total.bytesIn),
        );
        if (batch.files > 0) {
          pick = true;
          total.batches++;
          total.files += batch.files;
          total.packed += batch.packed;
          total.refused += batch.refused;
          total.bytesIn += batch.bytesIn;
          total.bytesOut += batch.bytesOut;
        }
        await nextTask();
      }
    } catch (err) {
      // the next pass tries again; a failing batch never spins
      deps.log.warn("kept packing failed", errorFields(err, false));
    }
    if (total.files > 0) {
      deps.log.info("kept packed", {
        batches: total.batches,
        files: total.files,
        packed: total.packed,
        refused: total.refused,
        bytes_in: total.bytesIn,
        bytes_out: total.bytesOut,
        duration: performance.now() - started,
      });
    }
    return total;
  };

  const pass = (): Promise<KeptPass> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    pass,
    start() {
      if (stopped || timer !== null) return;
      void pass();
      timer = setInterval(() => void pass(), KEPT_PASS_MS);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
