// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled fire refused for a full cap stays due, with nothing
// written. What the scheduler keeps in memory about those waits lives
// here: the projects and the process whose cap was full, cleared by a
// wake, the wake's generation, and the wait last logged per automation.
// An occurrence missed while waiting is replaced by the newest past one.

import { type Db, transact } from "../db/index.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { nextFire } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";

export const STILL_WAITING = "still waiting";

export type Waiting = {
  wait: "project" | "process";
  dueAt: number;
  projectId: string;
};

export class Waits {
  // a wake with no sleeper is kept: the sleep compares generations
  generation = 0;
  private readonly projects = new Set<string>();
  private process = false;
  private readonly logged = new Map<string, number>();
  // when the first cap was marked full since the last wake or retry
  private since: number | null = null;

  constructor(private readonly log: Log) {}

  wake(): void {
    this.generation++;
    this.retry();
  }

  // the caps are tried again without a wake once marked full for a
  // pass interval, so a lost wake costs a minute, never a fire
  retry(): void {
    this.projects.clear();
    this.process = false;
    this.since = null;
  }

  expire(now: number, after: number): void {
    if (this.since !== null && now - this.since >= after) this.retry();
  }

  // the waits of rows no longer due (deleted, suspended, rescheduled,
  // skipped) are forgotten
  prune(due: Set<string>): void {
    for (const id of this.logged.keys()) {
      if (!due.has(id)) this.logged.delete(id);
    }
  }

  // A wake since the attempt may have freed a place, so the cap is not
  // marked full. The wait is logged once per occurrence.
  block(id: string, wait: Waiting, seen: number, now: number): void {
    if (this.generation === seen) {
      if (wait.wait === "process") this.process = true;
      else this.projects.add(wait.projectId);
      this.since ??= now;
    }
    if (this.logged.get(id) === wait.dueAt) return;
    this.logged.set(id, wait.dueAt);
    this.log.info("wait", { automation: id, cap: wait.wait });
  }

  started(id: string): void {
    this.logged.delete(id);
  }

  get processFull(): boolean {
    return this.process;
  }

  projectFull(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  get any(): boolean {
    return this.process || this.projects.size > 0;
  }
}

// the newest occurrence at or before now once the one after dueAt has
// passed too; null while dueAt is the latest. A binary search over the time since
// dueAt, since a row missed through a long downtime would otherwise walk
// every occurrence in between
export function newestPast(
  schedule: string,
  tz: string,
  dueAt: number,
  now: number,
  // the successor, which a test counts
  after: typeof nextFire = nextFire,
): number | null {
  let newest = after(schedule, tz, dueAt);
  if (newest > now) return null;
  let low = newest;
  let high = now;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 2);
    const next = after(schedule, tz, mid);
    if (next <= now) {
      newest = Math.max(newest, next);
      low = Math.max(mid, next);
    } else {
      high = mid;
    }
  }
  for (;;) {
    const next = after(schedule, tz, newest);
    if (next > now) return newest;
    newest = next;
  }
}

// a missed occurrence is one skipped event, and next_at moves to the
// newest past one, which the same pass then tries
export function replaceMissed(
  deps: { db: Db; store: AutomationStore; log: Log },
  id: string,
  now: number,
): void {
  let skipped = false;
  try {
    transact(deps.db, () => {
      const row = deps.store.byId(id);
      if (row === null || row.suspendedAt !== null || row.nextAt === null) {
        return { result: undefined };
      }
      const newest = newestPast(row.schedule, row.tz, row.nextAt, now);
      if (newest === null) return { result: undefined };
      skipped = true;
      const updated = deps.store.recordEvent(row.id, {
        at: now,
        dueAt: row.nextAt,
        source: "schedule",
        outcome: "skipped",
        reason: STILL_WAITING,
        nextAt: newest,
      })!;
      return {
        result: undefined,
        events: [
          {
            type: "automation.changed" as const,
            data: { projectId: updated.projectId, automation: updated },
          },
        ],
      };
    });
  } catch (err) {
    deps.log.error("replace failed", { automation: id, ...errorFields(err) });
    return;
  }
  if (skipped) deps.log.info("skip", { automation: id, reason: STILL_WAITING });
}

export const RESTARTING = "restarting";

// during a drain a due row records a deferred event, once per due time,
// and keeps its next_at, so the next start fires it
export function deferDue(
  deps: { db: Db; store: AutomationStore; log: Log },
  id: string,
  now: number,
): void {
  let deferred = false;
  try {
    transact(deps.db, () => {
      const row = deps.store.byId(id);
      if (
        row === null ||
        row.suspendedAt !== null ||
        row.nextAt === null ||
        row.nextAt > now ||
        (row.lastEventOutcome === "deferred" &&
          row.lastEventDueAt === row.nextAt)
      ) {
        return { result: undefined };
      }
      deferred = true;
      const updated = deps.store.recordEvent(row.id, {
        at: now,
        dueAt: row.nextAt,
        source: "schedule",
        outcome: "deferred",
        reason: RESTARTING,
      })!;
      return {
        result: undefined,
        events: [
          {
            type: "automation.changed" as const,
            data: { projectId: updated.projectId, automation: updated },
          },
        ],
      };
    });
  } catch (err) {
    deps.log.error("defer failed", { automation: id, ...errorFields(err) });
    return;
  }
  if (deferred) deps.log.info("defer", { automation: id });
}
