// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kept MCP files of archived chats and ended runs, packed by a job
// of their own: a chat may keep up to mcpKeptBytes, too much for a click
// or for the synchronous sweep. Small batches, each its own transaction,
// the event loop let run between them. A batch picks its sessions inside
// its transaction, so what it writes ended and is not due for deletion
// at that moment.

import { KEPT_PACKABLE, type KeptBatch, packKeptBatch } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type Clock, DAY_MS, HOUR_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";

// raw input a batch packs, one file past it alone; provisional, set by
// the event loop stall measured on the smallest pod
export const KEPT_BATCH_BYTES = 4 * 1024 * 1024;

// raw input a pass packs, several times the heavy case's hourly growth;
// provisional, set by measurement
export const KEPT_PASS_BYTES = 1024 * 1024 * 1024;

export const KEPT_PASS_MS = HOUR_MS;

// the sessions one batch looks through; it stops sooner at its bytes
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

// ended, with a file to try, and not due for deletion: a chat archived
// within archivedDeleteDays, an orphaned run inside the same cut (the
// sweep's), a task's run within its retention (the scheduler's)
const ELIGIBLE = `select sessions.id as id from sessions
  left join automations on automations.id = sessions.automation_id
  where sessions.id in (select session_id from mcp_kept_files
      where ${KEPT_PACKABLE})
    and sessions.status <> 'running'
    and ((sessions.origin = 'chat' and sessions.archived_at >= ?)
      or (sessions.origin = 'automation' and sessions.automation_id is null
        and sessions.last_activity_at >= ?)
      or (sessions.origin = 'automation' and automations.id is not null
        and sessions.last_activity_at >=
          ? - automations.retention_days * ${DAY_MS}))
  order by sessions.last_activity_at, sessions.id limit ?`;

// in its own transaction: the next files of the oldest eligible sessions
export function packKeptOnce(
  deps: Pick<KeptPackDeps, "db" | "clock" | "limits">,
  maxBytes: number,
): KeptBatch {
  return transact(deps.db, () => {
    const now = deps.clock();
    const cut = now - deps.limits.current().archivedDeleteDays * DAY_MS;
    const ids = deps.db
      .query<{ id: string }, [number, number, number, number]>(ELIGIBLE)
      .all(cut, cut, now, SESSIONS_PER_BATCH)
      .map((row) => row.id);
    return { result: packKeptBatch(deps.db, ids, maxBytes) };
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
      while (!stopped && total.bytesIn < passBytes) {
        const batch = packKeptOnce(
          deps,
          Math.min(batchBytes, passBytes - total.bytesIn),
        );
        if (batch.files === 0) break;
        total.batches++;
        total.files += batch.files;
        total.packed += batch.packed;
        total.refused += batch.refused;
        total.bytesIn += batch.bytesIn;
        total.bytesOut += batch.bytesOut;
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
