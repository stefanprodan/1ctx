// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage: one row per round, what the provider reported, written by the
// runner in the round's transaction. The weekly summary reads the rows
// here so the runner does not own dashboard policy. No delete removes
// a row: usage is the record of what was spent and outlives its session,
// send, project and agent. Decisions are counted apart, one row each.

import type {
  DirectoryAgentDaysResponse,
  DirectoryDeciderDaysResponse,
} from "../../shared/api/directory.ts";
import type { RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import {
  type DecisionUsageFields,
  type DecisionUsageRow,
  DecisionUsageStore,
} from "./decisions.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type UsageFields, type UsageRow, UsageStore } from "./store.ts";
import { type UsageWindow, usageWindow } from "./window.ts";

export {
  type DecisionSlot,
  type DecisionSums,
  type DecisionUsageFields,
  decisionSlots,
} from "./decisions.ts";
export { parseZoneQuery } from "./parse.ts";
export { type UsageFields, UsageStore } from "./store.ts";
export {
  countByDay,
  daysWindow,
  lastDays,
  monthWindow,
  nextDay,
  type UsageWindow,
  usageWindow,
  zoneOrUtc,
} from "./window.ts";

export type UsageDeps = { db: Db; clock: Clock; access: AccessPort };

export type Usage = {
  store: UsageStore;
  record(fields: UsageFields): UsageRow;
  recordDecision(fields: DecisionUsageFields): DecisionUsageRow;
  // the last round of a chat agent counted for a session, never a
  // summoned turn's, or for many at once
  latest(sessionId: string): RoundUsage | null;
  latestFor(sessionIds: string[]): Map<string, RoundUsage>;
  // that last round as its row, whose send and round name what it counted
  latestRound(sessionId: string): UsageRow | null;
  // an agent's year of days in the zone, every project in one series
  agentDays(agentId: string, timeZone: string): DirectoryAgentDaysResponse;
  // a decider's year of answers in the zone, Checks left out
  deciderDays(
    deciderId: string,
    timeZone: string,
  ): DirectoryDeciderDaysResponse;
  total: UsageStore["total"];
  activeProjects: UsageStore["activeProjects"];
  decisionTotal: DecisionUsageStore["total"];
  routes: RouteDescriptor[];
};

export function usageArea(deps: UsageDeps): Usage {
  const store = new UsageStore(deps.db);
  const decisions = new DecisionUsageStore(deps.db);
  // the year of days in the zone, with what read sums over them
  const inWindow = <T extends object>(
    timeZone: string,
    read: (starts: number[], until: number) => T,
  ): Omit<UsageWindow, "starts"> & T => {
    const { days, starts, since, until } = usageWindow(deps.clock(), timeZone);
    return { since, until, days, ...read(starts, until) };
  };
  return {
    store,
    record: (fields) => store.record(fields),
    recordDecision: (fields) => decisions.record(fields),
    latest: (sessionId) => store.latest(sessionId),
    latestFor: (sessionIds) => store.latestFor(sessionIds),
    latestRound: (sessionId) => store.latestRound(sessionId),
    total: (by, since, until) => store.total(by, since, until),
    activeProjects: (ids, since, until) =>
      store.activeProjects(ids, since, until),
    decisionTotal: (by, since, until) => decisions.total(by, since, until),
    agentDays: (agentId, timeZone) =>
      inWindow(timeZone, (starts, until) =>
        store.agentDays(agentId, starts, until),
      ),
    deciderDays: (deciderId, timeZone) =>
      inWindow(timeZone, (starts, until) =>
        decisions.deciderDays(deciderId, starts, until),
      ),
    routes: routes({ clock: deps.clock, store, access: deps.access }),
  };
}
