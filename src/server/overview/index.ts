// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview area: what an admin reads about the instance. Storage
// is one scan of the file in a worker over its own connection, or
// inline over the app's when the database is in memory, kept a minute
// and shaped for the caller's zone at each request. The overview's
// days are the same worker's other job, kept a minute per zone. The
// load is the process's word at each request: its pools, its sockets
// and its CPU and memory, sampled from the start.

import {
  LOAD_SAMPLE_MS,
  type LoadResponse,
  type OverviewResponse,
  type StorageResponse,
} from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { scanCache } from "./cache.ts";
import { type Probe, processProbe, sampler } from "./load.ts";
import { daysOf, overviewResponse } from "./overview.ts";
import { type RangeInput, type RangeResult, range } from "./range.ts";
import { routes } from "./routes.ts";
import { type ScanInput, type ScanResult, scan } from "./scan.ts";
import {
  STORAGE_DAYS,
  type StorageLimits,
  storageResponse,
} from "./storage.ts";
import { type Scanner, workerScanner } from "./worker.ts";

export { KEEP_MS } from "./cache.ts";
export {
  type Probe,
  processProbe,
  type Reading,
  sampler,
} from "./load.ts";
export { daysOf, median, overviewResponse } from "./overview.ts";
export { parseLoadQuery, parseZoneQuery } from "./parse.ts";
export { type RangeInput, type RangeResult, range } from "./range.ts";
export { type ScanInput, type ScanResult, scan } from "./scan.ts";
export { STORAGE_TABLES, storageResponse } from "./storage.ts";
export { type Scanner, workerScanner } from "./worker.ts";

export type OverviewDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  limits: { current(): StorageLimits & { runsRunning: number } };
  // the build /api/health answers and when the process composed
  version: string;
  startedAt: number;
  // the sends running now by pool, and the chat pool's process cap
  pools(): { chats: number; chatsCap: number; runs: number };
  // the users with an open socket; web/ is built later, so a closure
  online(): number;
  // every automation, and those whose fire waits for a run slot
  automations(): { total: number; waiting: number };
  // a test's process; absent, this one, sampled every LOAD_SAMPLE_MS
  probe?: Probe;
  // a test's timer; absent, setInterval, kept from holding the process
  every?: (ms: number, tick: () => void) => () => void;
  // scan.worker.ts as the composition root resolves it
  worker: URL;
  // a test's scanner; absent, the worker over the file or inline
  scanner?: Scanner;
};

export type Overview = {
  routes: RouteDescriptor[];
  storage(timeZone: string): Promise<StorageResponse>;
  overview(timeZone: string): Promise<OverviewResponse>;
  load(): LoadResponse;
  start(): void;
  close(): void;
};

const DAY_MS = 86_400_000;

export function inlineScanner(db: Db): Scanner {
  return {
    scan: (input: ScanInput) => Promise.resolve(scan(db, input)),
    range: (input: RangeInput) => Promise.resolve(range(db, input)),
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
  async function failing<T>(what: string, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      deps.log.warn(what, errorFields(error, false));
      throw error;
    }
  }
  const scans = scanCache<ScanResult>({
    clock: deps.clock,
    run: () =>
      failing("storage scan failed", () => {
        const now = deps.clock();
        // a day more than the window, so no zone's first day is short
        const since = now - (STORAGE_DAYS * 2 + 1) * DAY_MS;
        return scanner.scan({ now, since });
      }),
  });
  const storage = async (timeZone: string) =>
    storageResponse(await scans.get(), timeZone, deps.limits.current());
  const ranges = scanCache<RangeResult>({
    clock: deps.clock,
    run: (timeZone) =>
      failing("overview read failed", () => {
        const now = deps.clock();
        const window = daysOf(now, timeZone);
        return scanner.range({
          now,
          since: window.starts[0]!,
          until: window.until,
        });
      }),
  });
  const overview = async (timeZone: string) => {
    const result = await ranges.get(timeZone);
    return overviewResponse(result, daysOf(result.readAt, timeZone), {
      version: deps.version,
      startedAt: deps.startedAt,
    });
  };
  const probe = deps.probe ?? processProbe();
  const samples = sampler({ clock: deps.clock, probe });
  samples.sample();
  const every =
    deps.every ??
    ((ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  let stop: (() => void) | null = null;
  const load = (): LoadResponse => {
    const pools = deps.pools();
    const automations = deps.automations();
    return {
      at: deps.clock(),
      chats: pools.chats,
      chatsCap: pools.chatsCap,
      runs: pools.runs,
      runsCap: deps.limits.current().runsRunning,
      online: deps.online(),
      automations: automations.total,
      waiting: automations.waiting,
      cores: probe.cores,
      memoryLimit: probe.memoryLimit,
      contained: probe.contained,
      samples: samples.samples(),
    };
  };
  return {
    routes: routes({ storage, overview, load }),
    storage,
    overview,
    load,
    // the sampling loop, started only by an activated app
    start() {
      stop ??= every(LOAD_SAMPLE_MS, () => samples.sample());
    },
    close() {
      stop?.();
      stop = null;
      scanner.close();
    },
  };
}
