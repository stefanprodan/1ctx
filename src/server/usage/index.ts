// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage: one row per round, what the provider reported, written by the
// runner in the round's transaction. The weekly summary reads the rows
// here so the runner does not own dashboard policy.

import type { RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type AccessPort, routes } from "./routes.ts";
import { type UsageFields, type UsageRow, UsageStore } from "./store.ts";

export { parseZoneQuery } from "./parse.ts";
export { type UsageFields, type UsageRow, UsageStore } from "./store.ts";

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
    routes: routes({ clock: deps.clock, store, access: deps.access }),
  };
}
