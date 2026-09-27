// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage page's words, pure: the months its arrows step through, the bars of each
// breakdown, the turn lengths and the deciders. A bar's hint says only
// what the bar does not.

import type {
  DeciderUsage,
  ModelUsage,
  TurnLength,
  UsageRow,
} from "../../../shared/api/admin.ts";
import { count, pluralCommas, share } from "../../lib/format.ts";
import { money } from "./Overview.model.ts";

type RowsBy = "projects" | "agents";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// a month as the head names it: "September 2026", or "Sep 2026" short;
// fixed words, since ICU builds abbreviate differently
export function monthLabel(month: string, short = false): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const name = MONTHS[number - 1]!;
  return `${short ? name.slice(0, 3) : name} ${year}`;
}

// the month `by` months after this one, "2026-09" and -1 is "2026-08"
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + number - 1 + by;
  const shifted = Math.floor(index / 12);
  return `${shifted}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// where the arrows lead: back while there is a month from the first
// turn's on, forward until this month; null where an arrow is off
export function monthSteps(month: string, first: string | null, now: string) {
  const start = first !== null && first < now ? first : now;
  return {
    back: month > start ? shiftMonth(month, -1) : null,
    forward: month < now ? shiftMonth(month, 1) : null,
  };
}

// A breakdown's row as a bar: a personal project by its owner, a team
// project by its name, an agent in mono. The deleted projects come as
// one row named for them, which needs no mark; a retired agent is
// marked gone, apart from a live one of its name. The hint says only
// what the bar does not: the share and what ran.
export function usageBars(kind: RowsBy, rows: UsageRow[]) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row, i) => {
    const name =
      row.owner !== null
        ? `@${row.owner}`
        : kind === "projects"
          ? row.name === null
            ? "deleted projects"
            : `#${row.name}`
          : (row.name ?? "");
    const hint = [
      share(row.tokens, total),
      ...(row.cost !== null ? [money(row.cost)] : []),
      ...(row.turns > 0 || row.runs === 0
        ? [pluralCommas(row.turns, "turn", "turns")]
        : []),
      ...(row.runs > 0 ? [pluralCommas(row.runs, "run", "runs")] : []),
    ].join(" · ");
    return {
      key: row.id ?? (row.deleted ? "deleted" : `${row.owner ?? "row"}-${i}`),
      name,
      mono: kind === "agents",
      gone: row.deleted && kind === "agents",
      value: row.tokens,
      label: count(row.tokens),
      hint,
    };
  });
}

// a turn's length: "41s", "3m 20s", "1h 5m"
export function lengthWord(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return `${Math.floor(s / 60)}m${rest ? ` ${rest}s` : ""}`;
  }
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ""}`;
}

// A model without its org, as the agent rows show it, unless what is
// left is a bare word ("openrouter/free").
export function modelLabel(model: string): string {
  const rest = model.slice(model.lastIndexOf("/") + 1);
  return /[\d-]/.test(rest) ? rest : model;
}

// the models by their median turn, the turns and the slowest the hint
export function lengthBars(lengths: TurnLength[]) {
  return lengths.map((m) => ({
    key: `${m.provider}/${m.model}`,
    name: modelLabel(m.model),
    value: m.medianMs ?? 0,
    label: m.medianMs === null ? "running" : lengthWord(m.medianMs),
    hint: [
      pluralCommas(m.turns, "turn", "turns"),
      ...(m.slowestMs !== null ? [`slowest ${lengthWord(m.slowestMs)}`] : []),
    ].join(" · "),
  }));
}

// the models by their tokens, the provider and the cost in the hint;
// a deleted provider's model says so
export function modelBars(rows: ModelUsage[]) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  // two deleted providers may share a model, so a gone one keys by place
  return rows.map((row, i) => ({
    key: `${row.provider ?? `gone-${i}`}/${row.model}`,
    name: modelLabel(row.model),
    mono: true,
    value: row.tokens,
    label: count(row.tokens),
    hint: [
      row.provider ?? "deleted provider",
      share(row.tokens, total),
      ...(row.cost !== null ? [money(row.cost)] : []),
    ].join(" · "),
  }));
}

// the deciders by the decisions they answered, tokens and cost in the
// hint
export function deciderBars(rows: DeciderUsage[]) {
  return rows.map((row) => ({
    key: row.name,
    name: row.name,
    mono: true,
    value: row.decisions,
    label: count(row.decisions),
    hint: [
      `${count(row.tokens)} tokens`,
      ...(row.cost !== null ? [money(row.cost)] : []),
    ].join(" · "),
  }));
}
