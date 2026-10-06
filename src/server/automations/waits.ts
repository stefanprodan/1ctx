// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the scheduler keeps in memory about cap waits.

import { MINUTE_MS } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import { type RecordDeps, recordOn } from "./events.ts";
import { nextFire } from "./schedule.ts";

const STILL_WAITING = "still waiting";

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
// passed too; null while dueAt is the latest. A binary search over the
// time since dueAt, since a row missed through a long downtime would
// otherwise walk every occurrence in between
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
  while (high - low > MINUTE_MS) {
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
export function replaceMissed(deps: RecordDeps, id: string, now: number): void {
  const skipped = recordOn(deps, id, "replace failed", (row, dueAt) => {
    const newest = newestPast(row.schedule, row.tz, dueAt, now);
    return newest === null
      ? null
      : {
          at: now,
          dueAt,
          source: "schedule",
          outcome: "skipped",
          reason: STILL_WAITING,
          nextAt: newest,
        };
  });
  if (skipped) deps.log.info("skip", { automation: id, reason: STILL_WAITING });
}
