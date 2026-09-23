// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview answer from one range read: the quarter hours laid on
// the zone's days, the last `days` as the days and the same number
// before them summed as before, the ten largest rows of each
// breakdown, the ten models with the most sends, and the instance. The
// pools and the sockets come from the caller, read at each request.

import type {
  ModelHealth,
  OverviewDay,
  OverviewRange,
  OverviewResponse,
  OverviewTotals,
  UsageBy,
  UsageRow,
} from "../../shared/api/admin.ts";
import { USAGE_BY } from "../../shared/api/admin.ts";
import { daysWindow, type UsageWindow } from "../usage/index.ts";
import type { GroupRow, ModelRow, RangeResult } from "./range.ts";
import { SLOT_MS } from "./range.ts";

const TOP = 10;

export type Now = OverviewResponse["now"];

export type Instance = Pick<
  OverviewResponse["instance"],
  "version" | "startedAt"
>;

// the range's bounds in the zone: the days, and the same number before
export function rangeWindow(
  now: number,
  timeZone: string,
  days: OverviewRange,
): UsageWindow {
  return daysWindow(now, timeZone, days * 2);
}

type Bucket = OverviewTotals;

const bucket = (): Bucket => ({
  sends: 0,
  failed: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  rounds: 0,
  pricedRounds: 0,
  cost: null,
});

const addCost = (into: Bucket, priced: number, cost: number | null) => {
  into.pricedRounds += priced;
  if (priced > 0) into.cost = (into.cost ?? 0) + (cost ?? 0);
};

// each slot's row onto the day it falls in; a slot before the window
// is skipped, one past it ends the walk
function lay<T extends { slot: number }>(
  rows: T[],
  bounds: number[],
  add: (into: Bucket, row: T) => void,
  buckets: Bucket[],
): void {
  let day = 0;
  for (const row of rows) {
    const at = row.slot * SLOT_MS;
    if (at < bounds[0]!) continue;
    while (day < buckets.length && at >= bounds[day + 1]!) day++;
    if (day >= buckets.length) break;
    add(buckets[day]!, row);
  }
}

function sum(buckets: Bucket[]): OverviewTotals {
  const total = bucket();
  for (const b of buckets) {
    total.sends += b.sends;
    total.failed += b.failed;
    total.promptTokens += b.promptTokens;
    total.cachedTokens += b.cachedTokens;
    total.completionTokens += b.completionTokens;
    total.rounds += b.rounds;
    addCost(total, b.pricedRounds, b.cost);
  }
  return total;
}

function days(
  result: RangeResult,
  window: UsageWindow,
  count: OverviewRange,
): Pick<OverviewResponse, "days" | "totals" | "before"> {
  const bounds = [...window.starts, window.until];
  const buckets = Array.from({ length: bounds.length - 1 }, bucket);
  lay(
    result.sends,
    bounds,
    (into, row) => {
      into.sends += row.sends;
      into.failed += row.failed;
    },
    buckets,
  );
  lay(
    result.usage,
    bounds,
    (into, row) => {
      into.promptTokens += row.prompt;
      into.cachedTokens += row.cached;
      into.completionTokens += row.completion;
      into.rounds += row.rounds;
      addCost(into, row.priced, row.cost);
    },
    buckets,
  );
  const own = buckets.slice(count);
  return {
    days: window.days.slice(count).map(
      (label, i): OverviewDay => ({
        day: label,
        start: window.starts[count + i]!,
        sends: own[i]!.sends,
        failed: own[i]!.failed,
        promptTokens: own[i]!.promptTokens,
        cachedTokens: own[i]!.cachedTokens,
        completionTokens: own[i]!.completionTokens,
      }),
    ),
    totals: sum(own),
    before: sum(buckets.slice(0, count)),
  };
}

const top = (rows: GroupRow[]): UsageRow[] =>
  rows
    .filter((row) => row.tokens > 0 || row.sends > 0)
    .sort((a, b) => b.tokens - a.tokens || b.sends - a.sends)
    .slice(0, TOP)
    .map(({ key: _key, ...row }) => row);

function by(result: RangeResult): Record<UsageBy, UsageRow[]> {
  const out = {} as Record<UsageBy, UsageRow[]>;
  for (const kind of USAGE_BY) out[kind] = top(result.by[kind]);
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const health = (row: ModelRow): ModelHealth => ({
  provider: row.provider,
  model: row.model,
  sends: row.sends,
  failed: row.failed,
  medianMs: median(row.lengths),
  slowestMs: row.lengths.length === 0 ? null : Math.max(...row.lengths),
  medianRounds: median(row.rounds),
});

export function overviewResponse(
  result: RangeResult,
  window: UsageWindow,
  count: OverviewRange,
  now: Now,
  instance: Instance,
): OverviewResponse {
  return {
    readAt: result.readAt,
    ...days(result, window, count),
    now,
    by: by(result),
    models: result.models.slice(0, TOP).map(health),
    instance: { ...instance, ...result.instance },
  };
}
