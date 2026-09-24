// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview answer from one read: the quarter hours laid on the
// zone's days, their totals, the ten largest rows of each breakdown,
// the ten models with the most turns, all time and the instance.

import {
  OVERVIEW_DAYS,
  type OverviewDay,
  type OverviewResponse,
  type OverviewTotals,
  type TurnLength,
  USAGE_BY,
  type UsageBy,
  type UsageRow,
} from "../../shared/api/admin.ts";
import { daysWindow, type UsageWindow } from "../usage/index.ts";
import type {
  GroupRow,
  ModelRow,
  RangeResult,
  SendSlot,
  UsageSlot,
} from "./range.ts";
import { SLOT_MS } from "./range.ts";

const TOP = 10;

export type Instance = Pick<
  OverviewResponse["instance"],
  "version" | "startedAt"
>;

// the days' bounds in the zone
export const daysOf = (now: number, timeZone: string): UsageWindow =>
  daysWindow(now, timeZone, OVERVIEW_DAYS);

const empty = (): OverviewTotals => ({
  turns: 0,
  turnsFailed: 0,
  runs: 0,
  runsFailed: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  rounds: 0,
  pricedRounds: 0,
  cost: null,
});

const addSends = (into: OverviewTotals, row: Omit<SendSlot, "slot">) => {
  into.turns += row.turns;
  into.turnsFailed += row.turnsFailed;
  into.runs += row.runs;
  into.runsFailed += row.runsFailed;
};

type Usage = Pick<
  OverviewTotals,
  | "promptTokens"
  | "cachedTokens"
  | "completionTokens"
  | "rounds"
  | "pricedRounds"
  | "cost"
>;

const addUsage = (into: OverviewTotals, row: Usage) => {
  into.promptTokens += row.promptTokens;
  into.cachedTokens += row.cachedTokens;
  into.completionTokens += row.completionTokens;
  into.rounds += row.rounds;
  into.pricedRounds += row.pricedRounds;
  if (row.pricedRounds > 0) into.cost = (into.cost ?? 0) + (row.cost ?? 0);
};

const usageOf = (row: Omit<UsageSlot, "slot">): Usage => ({
  promptTokens: row.prompt,
  cachedTokens: row.cached,
  completionTokens: row.completion,
  rounds: row.rounds,
  pricedRounds: row.priced,
  cost: row.cost,
});

// each slot's row onto the day it falls in; a slot before the window
// is skipped, one past it ends the walk
function lay<T extends { slot: number }>(
  rows: T[],
  bounds: number[],
  add: (into: OverviewTotals, row: T) => void,
  buckets: OverviewTotals[],
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

function days(
  result: RangeResult,
  window: UsageWindow,
): Pick<OverviewResponse, "days" | "totals"> {
  const bounds = [...window.starts, window.until];
  const buckets = window.starts.map(empty);
  lay(result.sends, bounds, addSends, buckets);
  lay(
    result.usage,
    bounds,
    (into, row) => addUsage(into, usageOf(row)),
    buckets,
  );
  const totals = empty();
  for (const b of buckets) {
    addSends(totals, b);
    addUsage(totals, b);
  }
  return {
    days: window.days.map(
      (label, i): OverviewDay => ({
        day: label,
        start: window.starts[i]!,
        turns: buckets[i]!.turns,
        turnsFailed: buckets[i]!.turnsFailed,
        runs: buckets[i]!.runs,
        runsFailed: buckets[i]!.runsFailed,
        promptTokens: buckets[i]!.promptTokens,
        cachedTokens: buckets[i]!.cachedTokens,
        completionTokens: buckets[i]!.completionTokens,
        cost: buckets[i]!.cost,
      }),
    ),
    totals,
  };
}

const top = (rows: GroupRow[]): UsageRow[] =>
  rows
    .filter((row) => row.tokens > 0 || row.turns > 0 || row.runs > 0)
    .sort(
      (a, b) => b.tokens - a.tokens || b.turns + b.runs - (a.turns + a.runs),
    )
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

const length = (row: ModelRow): TurnLength => ({
  provider: row.provider,
  model: row.model,
  turns: row.turns,
  medianMs: median(row.lengths),
  slowestMs: row.lengths.length === 0 ? null : Math.max(...row.lengths),
});

function allTime(result: RangeResult): OverviewResponse["all"] {
  const all = { ...empty(), since: result.all.since };
  addSends(all, result.all);
  addUsage(all, usageOf(result.all));
  return all;
}

export function overviewResponse(
  result: RangeResult,
  window: UsageWindow,
  instance: Instance,
): OverviewResponse {
  return {
    readAt: result.readAt,
    ...days(result, window),
    by: by(result),
    lengths: result.models.slice(0, TOP).map(length),
    all: allTime(result),
    instance: { ...instance, ...result.instance },
  };
}
