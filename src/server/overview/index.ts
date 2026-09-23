// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview area: what an admin reads about the instance. Storage
// is one scan of the file in a worker over its own connection, or
// inline over the app's when the database is in memory, kept a minute
// and shaped for the caller's zone at each request.

import type { StorageResponse } from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { scanCache } from "./cache.ts";
import { routes } from "./routes.ts";
import { type ScanInput, type ScanResult, scan } from "./scan.ts";
import {
  STORAGE_DAYS,
  type StorageLimits,
  storageResponse,
} from "./storage.ts";
import { type Scanner, workerScanner } from "./worker.ts";

export { KEEP_MS } from "./cache.ts";
export { parseStorageQuery } from "./parse.ts";
export { type ScanInput, type ScanResult, scan } from "./scan.ts";
export { STORAGE_TABLES, storageResponse } from "./storage.ts";
export { type Scanner, workerScanner } from "./worker.ts";

export type OverviewDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  limits: { current(): StorageLimits };
  // scan.worker.ts as the composition root resolves it
  worker: URL;
  // a test's scanner; absent, the worker over the file or inline
  scanner?: Scanner;
};

export type Overview = {
  routes: RouteDescriptor[];
  storage(timeZone: string): Promise<StorageResponse>;
  close(): void;
};

const DAY_MS = 86_400_000;

export function inlineScanner(db: Db): Scanner {
  return {
    scan: (input: ScanInput) => Promise.resolve(scan(db, input)),
    close() {},
  };
}

export function overviewArea(deps: OverviewDeps): Overview {
  const memory = deps.db.filename === "" || deps.db.filename === ":memory:";
  const scanner =
    deps.scanner ??
    (memory
      ? inlineScanner(deps.db)
      : workerScanner(deps.db.filename, deps.worker));
  const cache = scanCache<ScanResult>({
    clock: deps.clock,
    run: async () => {
      const now = deps.clock();
      // a day more than the window, so no zone's first day is short
      const since = now - (STORAGE_DAYS * 2 + 1) * DAY_MS;
      try {
        return await scanner.scan({ now, since });
      } catch (error) {
        deps.log.warn("storage scan failed", errorFields(error, false));
        throw error;
      }
    },
  });
  const storage = async (timeZone: string) =>
    storageResponse(await cache.get(), timeZone, deps.limits.current());
  return {
    routes: routes({ storage }),
    storage,
    close: () => scanner.close(),
  };
}
