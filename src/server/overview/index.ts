// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview area: what an admin reads about the instance. Storage
// is one scan of the file in a worker over its own connection, or
// inline over the app's when the database is in memory, kept a minute
// and shaped for the caller's zone at each request. The overview's
// days are the same worker's other job, kept a minute per zone and range, and the
// usage page's month a third, kept a minute per zone and month. The
// load is the process's word at each request: its pools, its sockets
// and its CPU and memory, sampled from the start; so is what needs
// attention, read from the config areas through a port.

import {
  type AttentionResponse,
  LOAD_SAMPLE_MS,
  type LoadResponse,
  type OverviewRange,
  type OverviewResponse,
  type StorageResponse,
  type UsageResponse,
} from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { monthWindow } from "../usage/index.ts";
import { type AttentionInput, attention } from "./attention.ts";
import { scanCache } from "./cache.ts";
import { type Probe, processProbe, sampler } from "./load.ts";
import {
  daysOf,
  firstOf,
  overviewResponse,
  usageResponse,
  windowOf,
} from "./overview.ts";
import {
  type MonthResult,
  month,
  type RangeInput,
  type RangeResult,
  range,
} from "./range.ts";
import { routes } from "./routes.ts";
import { type ScanInput, type ScanResult, scan } from "./scan.ts";
import {
  STORAGE_DAYS,
  type StorageLimits,
  storageResponse,
} from "./storage.ts";
import { type Scanner, workerScanner } from "./worker.ts";

export { type AttentionInput, attention } from "./attention.ts";
export { KEEP_MS } from "./cache.ts";
export {
  type Probe,
  processProbe,
  type Reading,
  sampler,
} from "./load.ts";
export {
  daysOf,
  firstOf,
  median,
  overviewResponse,
  usageResponse,
  windowOf,
} from "./overview.ts";
export {
  parseLoadQuery,
  parseOverviewQuery,
  parseUsageQuery,
  parseZoneQuery,
} from "./parse.ts";
export {
  type MonthResult,
  month,
  type RangeInput,
  type RangeResult,
  range,
} from "./range.ts";
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
  // the config rows and their key files; the areas are above, but the
  // secrets are read through compose's ports
  attention(): AttentionInput;
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
  overview(timeZone: string, range?: OverviewRange): Promise<OverviewResponse>;
  usage(timeZone: string, month: string): Promise<UsageResponse>;
  attention(): AttentionResponse;
  load(): LoadResponse;
  start(): void;
  close(): void;
};

const DAY_MS = 86_400_000;

export function inlineScanner(db: Db): Scanner {
  return {
    scan: (input: ScanInput) => Promise.resolve(scan(db, input)),
    range: (input: RangeInput) => Promise.resolve(range(db, input)),
    month: (input: RangeInput) => Promise.resolve(month(db, input)),
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
    run: (key) =>
      failing("overview read failed", () => {
        const [timeZone, range] = key.split("\n") as [string, OverviewRange];
        const now = deps.clock();
        // all reads every sum there is and lays its days from the first
        const window =
          range === "all"
            ? { since: 0, until: windowOf(now, timeZone, range, null).until }
            : daysOf(now, timeZone, range);
        return scanner.range({ now, since: window.since, until: window.until });
      }),
  });
  const overview = async (timeZone: string, range: OverviewRange = "30d") => {
    const result = await ranges.get(`${timeZone}\n${range}`);
    const window = windowOf(result.readAt, timeZone, range, firstOf(result));
    return overviewResponse(result, window, range, {
      version: deps.version,
      startedAt: deps.startedAt,
    });
  };
  const months = scanCache<MonthResult>({
    clock: deps.clock,
    run: (key) =>
      failing("usage read failed", () => {
        const [timeZone, name] = key.split("\n") as [string, string];
        const now = deps.clock();
        const window = monthWindow(now, timeZone, name);
        return scanner.month({ now, since: window.since, until: window.until });
      }),
  });
  const usage = async (timeZone: string, name: string) => {
    const result = await months.get(`${timeZone}\n${name}`);
    return usageResponse(
      result,
      monthWindow(result.readAt, timeZone, name),
      name,
    );
  };
  const needs = (): AttentionResponse => ({
    items: attention(deps.attention()),
  });
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
    routes: routes({ storage, overview, usage, attention: needs, load }),
    storage,
    overview,
    usage,
    attention: needs,
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
