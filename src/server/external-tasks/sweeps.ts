// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { taskChanged, writeEntry } from "./actions.ts";
import type { OpenClaim } from "./rows.ts";
import { closed } from "./rules.ts";
import type { ExternalTaskStore } from "./store.ts";

const hoursText = (hours: number) =>
  hours === 1 ? "1 hour" : `${hours} hours`;

type SweepDeps = {
  db: Db;
  store: ExternalTaskStore;
  clock: Clock;
  externalTaskIdleHours(): number;
  externalTaskDays(): number;
};

export function taskSweeps(deps: SweepDeps) {
  const { db, store } = deps;
  const end = (claims: readonly OpenClaim[]): BusEvent[] => {
    const events: BusEvent[] = [];
    const now = deps.clock();
    for (const claim of claims) {
      const task = store.byId(claim.task_id);
      if (task === null || task.claim?.id !== claim.id) continue;
      // A live claim has at most 240 counted entries; unclaim fits the 250 cap.
      const result = writeEntry(store, task, {
        actor: "access_gone",
        kind: "unclaim",
        userId: null,
        text: "access ended",
        links: [],
        at: now,
      });
      events.push(taskChanged(result.task));
    }
    return events;
  };
  const endForKeys = (keyIds: readonly string[]): BusEvent[] =>
    keyIds.length === 0 ? [] : end(store.claimsForKeys(keyIds));
  return {
    endForKeys,
    endForUser(userId: string, projectIds: readonly string[]): BusEvent[] {
      return projectIds.length === 0
        ? []
        : end(store.claimsForUser(userId, projectIds));
    },
    unclaimIdle(now: number): number {
      const hours = deps.externalTaskIdleHours();
      const cutoff = now - hours * 3_600_000;
      let count = 0;
      for (const candidate of store.openClaims(cutoff)) {
        count += transact(db, () => {
          const claim = store.claimById(candidate.id);
          if (
            claim === null ||
            claim.ended_at !== null ||
            claim.active_at > cutoff
          ) {
            return { result: 0 };
          }
          const task = store.byId(claim.task_id);
          if (
            task === null ||
            task.state !== "in_progress" ||
            task.claim?.id !== claim.id
          ) {
            return { result: 0 };
          }
          const result = writeEntry(store, task, {
            actor: "idle",
            kind: "unclaim",
            userId: null,
            text: `after ${hoursText(hours)} without a report`,
            links: [],
            at: now,
          });
          return { result: 1, events: [taskChanged(result.task)] };
        });
      }
      return count;
    },
    endClaims(keys: readonly string[] | (() => readonly string[])): number {
      return transact(db, () => {
        const keyIds = typeof keys === "function" ? keys() : keys;
        const events = endForKeys(keyIds);
        return { result: events.length, events };
      });
    },
    deleteClosed(now: number): number {
      const cutoff = now - deps.externalTaskDays() * 86_400_000;
      let count = 0;
      for (const id of store.expired(cutoff)) {
        count += transact(db, () => {
          const task = store.byId(id);
          if (task === null || !closed(task.state) || task.movedAt > cutoff) {
            return { result: 0 };
          }
          store.delete(id);
          return {
            result: 1,
            events: [
              {
                type: "externalTask.deleted",
                data: { projectId: task.projectId, taskId: id },
              },
            ],
          };
        });
      }
      return count;
    },
  };
}
