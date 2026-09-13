// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Usage: one row per round, what the provider reported, written by the
// runner in the round's transaction. The sums for a dashboard come
// later; the rows are here from the first send so nothing is lost.

import type { RoundUsage } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type UsageFields, type UsageRow, UsageStore } from "./store.ts";

export { type UsageFields, type UsageRow, UsageStore } from "./store.ts";

export type UsageDeps = { db: Db };

export type Usage = {
  store: UsageStore;
  record(fields: UsageFields): UsageRow;
  deleteSend(sendId: string): boolean;
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
    latest: (sessionId) => store.latest(sessionId),
    latestFor: (sessionIds) => store.latestFor(sessionIds),
    routes: [],
  };
}
