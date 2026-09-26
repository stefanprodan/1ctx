// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The limits area: the defaults with an admin's overrides on top.
// current() is read once when a send starts and copied onto its policy,
// so a change on the Tools page reaches the next send and never one in
// flight; the run caps are read at each admission. A value saved equal
// to its default drops the override rather than store it, so the rows
// are exactly what an admin changed.

import type { LimitsResponse } from "../../shared/api/limits.ts";
import type { LimitRow } from "../../shared/contracts/limit.ts";
import { LIMIT_NAMES, type LimitName } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { DEFAULT_LIMITS, LIMIT_DEFINITIONS, type Limits } from "./defaults.ts";
import { routes } from "./routes.ts";
import { LimitStore } from "./store.ts";

export {
  type ChatCaps,
  DEFAULT_LIMITS,
  type KnowledgeCaps,
  LIMIT_DEFINITIONS,
  type LimitDefinition,
  type Limits,
  LOOP_LIMITS,
  type LoopLimits,
  type RunCaps,
  TOOL_CAPS,
  type ToolCaps,
} from "./defaults.ts";
export { type LimitOverride, LimitStore } from "./store.ts";

export type LimitsDeps = {
  db: Db;
  clock: Clock;
  // a write moved a run cap, so a fire waiting for a slot may start
  runCapsChanged?: () => void;
};

export type LimitsArea = {
  store: LimitStore;
  routes: RouteDescriptor[];
  current(): Limits;
  rows(): LimitRow[];
  set(values: Limits, now: number): void;
  reset(): void;
};

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
  const runCaps = () => {
    const { runsPerUser, runsRunning } = current();
    return `${runsPerUser}/${runsRunning}`;
  };
  // after the commit, and only when a run cap moved
  const noticing = (write: () => void): void => {
    const before = runCaps();
    write();
    if (runCaps() !== before) deps.runCapsChanged?.();
  };
  const set = (values: Limits, now: number): void =>
    noticing(() => {
      transact(deps.db, () => {
        for (const name of LIMIT_NAMES) {
          if (values[name] === LIMIT_DEFINITIONS[name].default)
            store.delete(name);
          else store.set(name, values[name], now);
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
