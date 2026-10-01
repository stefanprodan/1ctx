// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The limits area: the defaults with an admin's overrides on top.
// current() is read once when a send starts and copied onto its policy,
// so a change on an admin page reaches the next send and never one in
// flight; the send caps are read at each admission. A value saved equal
// to its default drops the override rather than store it, so the rows
// are exactly what an admin changed.

import type { LimitsResponse } from "../../shared/api/limits.ts";
import type { LimitRow } from "../../shared/contracts/limit.ts";
import { LIMIT_NAMES, type LimitName } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  DEFAULT_LIMITS,
  LIMIT_DEFINITIONS,
  type Limits,
  type SendCaps,
} from "./defaults.ts";
import { routes } from "./routes.ts";
import { LimitStore } from "./store.ts";

export {
  type ChatCaps,
  DEFAULT_LIMITS,
  type KnowledgeCaps,
  LIMIT_DEFINITIONS,
  type Limits,
  LOOP_LIMITS,
  type LoopLimits,
  type RepoCaps,
  type SendCaps,
  scheduledShare,
  TOOL_CAPS,
  type ToolCaps,
} from "./defaults.ts";

export type LimitsDeps = {
  db: Db;
  clock: Clock;
  // a write moved a send cap, so a run waiting for a place may start
  wake?: () => void;
};

export type LimitsArea = {
  store: LimitStore;
  routes: RouteDescriptor[];
  current(): Limits;
  rows(): LimitRow[];
  set(values: Partial<Limits>, now: number): void;
  reset(): void;
};

// a user's cap never reads larger than the project's, nor the
// project's than the process's
function ordered(caps: SendCaps): void {
  if (caps.sendsPerUser > caps.sendsPerProject) {
    throw new BadRequest("sendsPerUser must not be above sendsPerProject");
  }
  if (caps.sendsPerProject > caps.sendsRunning) {
    throw new BadRequest("sendsPerProject must not be above sendsRunning");
  }
}

function effectiveValue(name: LimitName, override?: number): number {
  const entry = LIMIT_DEFINITIONS[name];
  return Math.max(entry.min, Math.min(entry.max, override ?? entry.default));
}

export function limitsArea(deps: LimitsDeps): LimitsArea {
  const store = new LimitStore(deps.db);
  const current = (): Limits => {
    const values = { ...DEFAULT_LIMITS };
    for (const override of store.rows()) {
      values[override.name] = effectiveValue(override.name, override.value);
    }
    return values;
  };
  const rows = (): LimitRow[] => {
    const overrides = new Map(store.rows().map((row) => [row.name, row]));
    return LIMIT_NAMES.map((name) => {
      const entry = LIMIT_DEFINITIONS[name];
      const override = overrides.get(name);
      return {
        name,
        value: effectiveValue(name, override?.value),
        default: entry.default,
        min: entry.min,
        max: entry.max,
        unit: entry.unit,
        scope: entry.scope,
        changedAt: override?.changedAt ?? null,
      };
    });
  };
  // the wait's minutes too, so the queue's expiry timer moves with them
  const sendCaps = () => {
    const { sendsPerUser, sendsPerProject, sendsRunning, queuedMinutes } =
      current();
    return `${sendsPerUser}/${sendsPerProject}/${sendsRunning}/${queuedMinutes}`;
  };
  // after the commit, and only when a send cap or the wait moved
  const noticing = (write: () => void): void => {
    const before = sendCaps();
    write();
    if (sendCaps() !== before) deps.wake?.();
  };
  const set = (values: Partial<Limits>, now: number): void =>
    noticing(() => {
      transact(deps.db, () => {
        ordered({ ...current(), ...values });
        for (const name of LIMIT_NAMES) {
          const value = values[name];
          if (value === undefined) continue;
          if (value === LIMIT_DEFINITIONS[name].default) store.delete(name);
          else store.set(name, value, now);
        }
        return { result: undefined };
      });
    });
  const reset = (): void => noticing(() => store.reset());
  const response = (): LimitsResponse => ({ limits: rows() });
  return {
    store,
    current,
    rows,
    set,
    reset,
    routes: routes({ clock: deps.clock, response, set, reset }),
  };
}
