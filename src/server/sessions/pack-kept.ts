// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kept MCP files of archived chats and ended runs, packed by a job
// of their own: a chat may keep up to mcpKeptBytes, too much for a click
// or for the synchronous sweep. A pass walks the sessions holding files
// to try by id, over the covering candidate index, a chunk at a time,
// and packs them in small batches. A batch copies its files' bytes,
// compresses them one at a time on Bun's thread pool, then writes in one
// short transaction that rechecks each session by key, so what it
// writes ended and is not due for deletion at that moment. The main
// thread only reads, copies and writes; the event loop runs between
// every step.

import {
  compressKept,
  type KeptPending,
  pendingKept,
  readKeptRaw,
  walkKept,
  writeKeptFrame,
} from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import { type Clock, DAY_MS, HOUR_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";

// raw input a batch reads, one file past it alone; 4 MiB stalled the
// event loop 50 ms at p99 on the load database's clone, 2 MiB 30 ms
export const KEPT_BATCH_BYTES = 2 * 1024 * 1024;

// raw input a pass packs, several times the heavy case's hourly growth;
// provisional, set by measurement
export const KEPT_PASS_BYTES = 1024 * 1024 * 1024;

export const KEPT_PASS_MS = HOUR_MS;

// the sessions one step of the walk reads from the index
const WALK_CHUNK = 256;

export type KeptPackDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  limits: { current(): { archivedDeleteDays: number } };
  // a test's budgets; the constants above by default
  batchBytes?: number;
  passBytes?: number;
};

export type KeptPass = {
  // batches that read files; files read, packed, left raw for good and
  // skipped since their session or row changed; raw bytes read and
  // frame bytes written
  batches: number;
  files: number;
  packed: number;
  refused: number;
  skipped: number;
  bytesIn: number;
  bytesOut: number;
};

export type KeptPacker = {
  // one pass to its end; a call while one runs gets that one
  pass(): Promise<KeptPass>;
  // a pass now, then hourly
  start(): void;
  // no batch starts after it; resolves once a running batch wrote
  stop(): Promise<void>;
};

// ended and not due for deletion, by key: a chat archived within
// archivedDeleteDays, an orphaned run inside the same cut (the sweep's),
// a task's run within its retention (the scheduler's); each a >= where
// its deleter has a <
export const KEPT_STILL = `select sessions.id as id from sessions
  left join automations on automations.id = sessions.automation_id
  where sessions.id = ?3 and sessions.status <> 'running'
    and ((sessions.origin = 'chat' and sessions.archived_at >= ?1)
      or (sessions.origin = 'automation' and sessions.automation_id is null
        and sessions.last_activity_at >= ?1)
      or (sessions.origin = 'automation' and automations.id is not null
        and sessions.last_activity_at >=
          ?2 - automations.retention_days * ${DAY_MS}))`;

type Deps = Pick<KeptPackDeps, "db" | "clock" | "limits">;

// where a pass's walk stands: the last id read, the eligible sessions
// of the chunk not yet done, and whether the index has more
type Walk = { after: string; queue: string[]; done: boolean };

type Read = KeptPending & { sessionId: string; raw: Uint8Array };

function stillCheck(deps: Deps): (sessionId: string) => boolean {
  const now = deps.clock();
  const cut = now - deps.limits.current().archivedDeleteDays * DAY_MS;
  const query = deps.db.query<{ id: string }, [number, number, string]>(
    KEPT_STILL,
  );
  return (sessionId) => query.get(cut, now, sessionId) !== null;
}

function step(deps: Deps, walk: Walk): void {
  const ids = walkKept(deps.db, walk.after, WALK_CHUNK);
  if (ids.length < WALK_CHUNK) walk.done = true;
  if (ids.length > 0) walk.after = ids[ids.length - 1]!;
  const still = stillCheck(deps);
  walk.queue = ids.filter(still);
}

/**
 * A batch's files, copied in order until the next would take the raw
 * input past maxBytes; the first is taken whatever its size. At most
 * one step of the walk, so a stretch of live sessions never holds the
 * thread; a session whose files are all taken leaves the queue.
 */
export function readBatch(deps: Deps, walk: Walk, maxBytes: number): Read[] {
  const files: Read[] = [];
  let bytes = 0;
  let stepped = false;
  for (;;) {
    if (walk.queue.length === 0) {
      if (walk.done || stepped) return files;
      step(deps, walk);
      stepped = true;
      continue;
    }
    const sessionId = walk.queue[0]!;
    for (const file of pendingKept(deps.db, sessionId)) {
      if (files.length > 0 && bytes + file.bytes > maxBytes) return files;
      const raw = readKeptRaw(deps.db, file.messageId, file.position);
      if (raw === null) continue;
      files.push({ ...file, sessionId, raw });
      bytes += file.bytes;
    }
    walk.queue.shift();
  }
}

// the batch's frames written, in one transaction that rechecks each
// session; a session that no longer qualifies leaves the queue
function writeBatch(
  deps: Deps,
  walk: Walk,
  files: Read[],
  frames: Uint8Array[],
): Omit<KeptPass, "batches" | "files" | "bytesIn"> {
  return transact(deps.db, () => {
    const out = { packed: 0, refused: 0, skipped: 0, bytesOut: 0 };
    const still = stillCheck(deps);
    const checked = new Map<string, boolean>();
    files.forEach((file, i) => {
      let ok = checked.get(file.sessionId);
      if (ok === undefined) {
        ok = still(file.sessionId);
        checked.set(file.sessionId, ok);
      }
      if (!ok) {
        out.skipped++;
        return;
      }
      const frame = frames[i]!;
      const written = writeKeptFrame(deps.db, file, file.raw.byteLength, frame);
      out[written]++;
      if (written === "packed") out.bytesOut += frame.byteLength;
    });
    const gone = new Set(
      [...checked].filter(([, ok]) => !ok).map(([id]) => id),
    );
    walk.queue = walk.queue.filter((id) => !gone.has(id));
    return { result: out };
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
      skipped: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
    const walk: Walk = { after: "", queue: [], done: false };
    try {
      while (!stopped && total.bytesIn < passBytes) {
        const files = readBatch(
          deps,
          walk,
          Math.min(batchBytes, passBytes - total.bytesIn),
        );
        if (files.length === 0) {
          if (walk.done && walk.queue.length === 0) break;
          await nextTask();
          continue;
        }
        // one at a time, so a batch holds about its own bytes twice
        const frames: Uint8Array[] = [];
        for (const file of files) frames.push(await compressKept(file.raw));
        // a batch begun before a stop still writes, before stop resolves
        const written = writeBatch(deps, walk, files, frames);
        total.batches++;
        total.files += files.length;
        total.bytesIn += files.reduce((sum, file) => sum + file.bytes, 0);
        total.packed += written.packed;
        total.refused += written.refused;
        total.skipped += written.skipped;
        total.bytesOut += written.bytesOut;
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
        skipped: total.skipped,
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
