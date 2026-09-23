// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled fire the run pool refused stays due, with nothing
// written. What the scheduler keeps in memory about those waits lives
// here: the owners and the process whose pool was full, cleared by a
// wake, the wake's generation, and the wait last logged per automation.
// An occurrence missed while waiting is replaced by the newest past one.

import { type Db, transact } from "../db/index.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { nextFire } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";

export const STILL_WAITING = "still waiting";

export type Waiting = {
  wait: "user" | "process";
  dueAt: number;
  ownerId: string;
};

export class Waits {
  // a wake with no sleeper is kept: the sleep compares generations
  generation = 0;
  private readonly owners = new Set<string>();
  private process = false;
  private readonly logged = new Map<string, number>();

  constructor(private readonly log: Log) {}

  wake(): void {
    this.generation++;
    this.owners.clear();
    this.process = false;
  }

  // A wake since the attempt may have freed a slot, so the pool is not
  // marked full. The wait is logged once per occurrence.
  block(id: string, wait: Waiting, seen: number): void {
    if (this.generation === seen) {
      if (wait.wait === "process") this.process = true;
      else this.owners.add(wait.ownerId);
    }
    if (this.logged.get(id) === wait.dueAt) return;
    this.logged.set(id, wait.dueAt);
    this.log.info("wait", { automation: id, pool: wait.wait });
  }

  started(id: string): void {
    this.logged.delete(id);
  }

  get processFull(): boolean {
    return this.process;
  }

  ownerFull(ownerId: string): boolean {
    return this.owners.has(ownerId);
  }

  get any(): boolean {
    return this.process || this.owners.size > 0;
  }
}

// the newest occurrence at or before now once the one after dueAt has
// passed too; null while dueAt is the latest
export function newestPast(
  schedule: string,
  tz: string,
  dueAt: number,
  now: number,
): number | null {
  let newest: number | null = null;
  let next = nextFire(schedule, tz, dueAt);
  while (next <= now) {
    newest = next;
    next = nextFire(schedule, tz, next);
  }
  return newest;
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
