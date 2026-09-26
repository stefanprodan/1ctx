// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage: one row per round, what the provider reported, written by the
// runner in the round's transaction. The weekly summary reads the rows
// here so the runner does not own dashboard policy.

import type { DirectoryAgentDaysResponse } from "../../shared/api/directory.ts";
import type { RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type UsageFields, type UsageRow, UsageStore } from "./store.ts";
import { usageWindow } from "./window.ts";

export { parseZoneQuery } from "./parse.ts";
export { type UsageFields, type UsageRow, UsageStore } from "./store.ts";
export { daysWindow, type UsageWindow } from "./window.ts";

export type UsageDeps = { db: Db; clock: Clock; access: AccessPort };

export type Usage = {
  store: UsageStore;
  record(fields: UsageFields): UsageRow;
  deleteSend(sendId: string): boolean;
  deleteProject(projectId: string): number;
  deleteSession(sessionId: string): number;
  deleteSessions(sessionIds: string[]): number;
  // the last round counted for a session, or for many at once
  latest(sessionId: string): RoundUsage | null;
  latestFor(sessionIds: string[]): Map<string, RoundUsage>;
  // an agent's year of days in the zone, every project in one series
  agentDays(agentId: string, timeZone: string): DirectoryAgentDaysResponse;
  routes: RouteDescriptor[];
};

export function usageArea(deps: UsageDeps): Usage {
  const store = new UsageStore(deps.db);
  return {
    store,
    record: (fields) => store.record(fields),
    deleteSend: (sendId) => store.deleteSend(sendId),
    deleteProject: (projectId) => store.deleteProject(projectId),
    deleteSession: (sessionId) => store.deleteSession(sessionId),
    deleteSessions: (sessionIds) => store.deleteSessions(sessionIds),
    latest: (sessionId) => store.latest(sessionId),
    latestFor: (sessionIds) => store.latestFor(sessionIds),
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
