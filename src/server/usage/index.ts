// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage: one row per round, what the provider reported, written by the
// runner in the round's transaction. The weekly summary reads the rows
// here so the runner does not own dashboard policy. No delete removes
// a row: usage is the record of what was spent and outlives its session,
// send, project and agent. Decisions are counted apart, one row each.

import type { DirectoryAgentDaysResponse } from "../../shared/api/directory.ts";
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
import { usageWindow } from "./window.ts";

export {
  type DecisionSlot,
  type DecisionSums,
  type DecisionUsageFields,
  type DecisionUsageRow,
  DecisionUsageStore,
  decisionSlots,
  decisionTotals,
} from "./decisions.ts";
export { parseZoneQuery } from "./parse.ts";
export { type UsageFields, type UsageRow, UsageStore } from "./store.ts";
export {
  countByDay,
  daysWindow,
  type UsageWindow,
  usageWindow,
} from "./window.ts";

export type UsageDeps = { db: Db; clock: Clock; access: AccessPort };

export type Usage = {
  store: UsageStore;
  decisions: DecisionUsageStore;
  record(fields: UsageFields): UsageRow;
  recordDecision(fields: DecisionUsageFields): DecisionUsageRow;
  // the last round counted for a session, or for many at once
  latest(sessionId: string): RoundUsage | null;
  latestFor(sessionIds: string[]): Map<string, RoundUsage>;
  // an agent's year of days in the zone, every project in one series
  agentDays(agentId: string, timeZone: string): DirectoryAgentDaysResponse;
  agentTotal: UsageStore["agentTotal"];
  providerTotal: UsageStore["providerTotal"];
  routes: RouteDescriptor[];
};

export function usageArea(deps: UsageDeps): Usage {
  const store = new UsageStore(deps.db);
  const decisions = new DecisionUsageStore(deps.db);
  return {
    store,
    decisions,
    record: (fields) => store.record(fields),
    recordDecision: (fields) => decisions.record(fields),
    latest: (sessionId) => store.latest(sessionId),
    latestFor: (sessionIds) => store.latestFor(sessionIds),
    agentTotal: (agentId, since, until) =>
      store.agentTotal(agentId, since, until),
    providerTotal: (providerId, since, until) =>
      store.providerTotal(providerId, since, until),
    agentDays(agentId, timeZone) {
      const { days, starts, since, until } = usageWindow(
        deps.clock(),
        timeZone,
      );
      return {
        since,
        until,
        days,
        ...store.agentDays(agentId, starts, until),
      };
    },
    routes: routes({ clock: deps.clock, store, access: deps.access }),
  };
}
