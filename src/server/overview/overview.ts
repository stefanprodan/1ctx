// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DaysAnswer,
  OverviewDay,
  OverviewRange,
  OverviewResponse,
  OverviewTotals,
  TurnLengths,
  UsageResponse,
  UsageRow,
} from "../../shared/api/admin.ts";
import { DAY_MS } from "../lib/clock.ts";
import {
  type DecisionSums,
  daysWindow,
  type UsageWindow,
} from "../usage/index.ts";
import type { GroupRow } from "./breakdowns.ts";
import type {
  DayReads,
  MonthResult,
  RangeResult,
  SendSlot,
  UsageSlot,
} from "./range.ts";
import { SLOT_MS } from "./read.ts";

const TOP = 10;

type Instance = Pick<OverviewResponse["instance"], "version" | "startedAt">;

export const daysOf = (
  now: number,
  timeZone: string,
  range: "30d" | "90d",
): UsageWindow => daysWindow(now, timeZone, range === "30d" ? 30 : 90);

export function firstOf(result: DayReads): number | null {
  const firsts = [result.sends, result.usage, result.decisions]
    .map((rows) => rows[0]?.slot)
    .filter((slot): slot is number => slot !== undefined);
  return firsts.length === 0 ? null : Math.min(...firsts) * SLOT_MS;
}

export function windowOf(
  now: number,
  timeZone: string,
  range: OverviewRange,
  first: number | null,
): UsageWindow {
  if (range !== "all") return daysOf(now, timeZone, range);
  const count =
    first === null ? 1 : Math.max(1, Math.ceil((now - first) / DAY_MS) + 1);
  const window = daysWindow(now, timeZone, count);
  // the rounding may lead with a day before the first sum's
  let from = 0;
  while (
    first !== null &&
    from < window.starts.length - 1 &&
    window.starts[from + 1]! <= first
  ) {
    from++;
  }
  return {
    days: window.days.slice(from),
    starts: window.starts.slice(from),
    since: window.starts[from]!,
    until: window.until,
  };
}

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
  decisions: 0,
  decisionTokens: 0,
  pricedDecisions: 0,
  decisionCost: null,
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

type Decided = Pick<
  OverviewTotals,
  "decisions" | "decisionTokens" | "pricedDecisions" | "decisionCost"
>;

const addDecisions = (into: OverviewTotals, row: Decided) => {
  into.decisions += row.decisions;
  into.decisionTokens += row.decisionTokens;
  into.pricedDecisions += row.pricedDecisions;
  if (row.pricedDecisions > 0) {
    into.decisionCost = (into.decisionCost ?? 0) + (row.decisionCost ?? 0);
  }
};

const decidedOf = (row: DecisionSums): Decided => ({
  decisions: row.decisions,
  decisionTokens: row.tokens,
  pricedDecisions: row.priced,
  decisionCost: row.cost,
});

const usageOf = (row: Omit<UsageSlot, "slot">): Usage => ({
  promptTokens: row.prompt,
  cachedTokens: row.cached,
  completionTokens: row.completion,
  rounds: row.rounds,
  pricedRounds: row.priced,
  cost: row.cost,
});

// ats sorted; one outside [bounds[0], the last bound) is skipped
function eachDay(
  ats: readonly number[],
  bounds: readonly number[],
  visit: (day: number, k: number) => void,
): void {
  const until = bounds[bounds.length - 1]!;
  let day = 0;
  ats.forEach((at, k) => {
    if (at < bounds[0]! || at >= until) return;
    while (at >= bounds[day + 1]!) day++;
    visit(day, k);
  });
}

function lay<T extends { slot: number }>(
  rows: T[],
  bounds: number[],
  add: (into: OverviewTotals, row: T) => void,
  buckets: OverviewTotals[],
): void {
  eachDay(
    rows.map((row) => row.slot * SLOT_MS),
    bounds,
    (day, k) => add(buckets[day]!, rows[k]!),
  );
}

// nearest rank
function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

const lengthsOf = (values: number[]): TurnLengths => ({
  medianMs: median(values),
  p95Ms: p95(values),
});

function days(
  result: DayReads,
  window: UsageWindow,
): Omit<DaysAnswer, "readAt"> {
  const bounds = [...window.starts, window.until];
  const buckets = window.starts.map(empty);
  const lengths: number[][] = window.starts.map(() => []);
  const all: number[] = [];
  eachDay(result.ended.at, bounds, (day, k) => {
    lengths[day]!.push(result.ended.ms[k]!);
    all.push(result.ended.ms[k]!);
  });
  const users = window.starts.map(() => new Set<number>());
  const everyone = new Set<number>();
  eachDay(
    result.actives.slot.map((slot) => slot * SLOT_MS),
    bounds,
    (day, k) => {
      users[day]!.add(result.actives.user[k]!);
      everyone.add(result.actives.user[k]!);
    },
  );
  lay(result.sends, bounds, addSends, buckets);
  lay(
    result.usage,
    bounds,
    (into, row) => addUsage(into, usageOf(row)),
    buckets,
  );
  lay(
    result.decisions,
    bounds,
    (into, row) => addDecisions(into, decidedOf(row)),
    buckets,
  );
  const totals = empty();
  for (const b of buckets) {
    addSends(totals, b);
    addUsage(totals, b);
    addDecisions(totals, b);
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
        decisions: buckets[i]!.decisions,
        decisionTokens: buckets[i]!.decisionTokens,
        pricedDecisions: buckets[i]!.pricedDecisions,
        decisionCost: buckets[i]!.decisionCost,
        ...lengthsOf(lengths[i]!),
        activeUsers: users[i]!.size,
      }),
    ),
    totals,
    turnLength: lengthsOf(all),
    activeUsers: everyone.size,
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

function by(result: MonthResult): UsageResponse["by"] {
  return {
    projects: top(result.by.projects),
    agents: top(result.by.agents),
    models: result.by.models
      .filter((row) => row.tokens > 0)
      .sort(
        (a, b) =>
          b.tokens - a.tokens ||
          a.model.localeCompare(b.model) ||
          (a.provider ?? "").localeCompare(b.provider ?? ""),
      )
      .slice(0, TOP),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function overviewResponse(
  result: RangeResult,
  window: UsageWindow,
  range: OverviewRange,
  instance: Instance,
): OverviewResponse {
  return {
    readAt: result.readAt,
    range,
    ...days(result, window),
    instance: { ...instance, ...result.instance },
  };
}

export function usageResponse(
  result: MonthResult,
  window: UsageWindow,
  month: string,
): UsageResponse {
  return {
    readAt: result.readAt,
    month,
    since: result.since,
    ...days(result, window),
    by: by(result),
    deciders: result.deciders
      .sort((a, b) => b.decisions - a.decisions || a.name.localeCompare(b.name))
      .slice(0, TOP),
  };
}
