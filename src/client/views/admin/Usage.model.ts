// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DeciderUsage,
  ModelUsage,
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

// fixed words, since ICU builds abbreviate differently
export function monthLabel(month: string, short = false): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const name = MONTHS[number - 1]!;
  return `${short ? name.slice(0, 3) : name} ${year}`;
}

function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + number - 1 + by;
  const shifted = Math.floor(index / 12);
  return `${shifted}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function monthSteps(month: string, first: string | null, now: string) {
  const start = first !== null && first < now ? first : now;
  return {
    back: month > start ? shiftMonth(month, -1) : null,
    forward: month < now ? shiftMonth(month, 1) : null,
  };
}

// a dash for a row not priced, apart from a free one's $0.00
function rowCost(priced: boolean, cost: number | null): string | undefined {
  if (!priced) return undefined;
  return cost === null ? "-" : money(cost);
}

const COSTLY_USD = 0.1;

const tokensSum = (rows: { tokens: number }[]): number =>
  rows.reduce((sum, row) => sum + row.tokens, 0);

const barOf = (
  row: { tokens: number; cost: number | null },
  priced: boolean,
) => ({
  value: row.tokens,
  label: count(row.tokens),
  cost: rowCost(priced, row.cost),
  costly: row.cost !== null && row.cost > COSTLY_USD,
});

export function usageBars(kind: RowsBy, rows: UsageRow[]) {
  return rowBars(
    kind,
    rows,
    tokensSum(rows),
    rows.some((row) => row.cost !== null),
  );
}

// the cost column may span more rows than these
function rowBars(
  kind: RowsBy,
  rows: UsageRow[],
  total: number,
  priced: boolean,
) {
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
      ...(row.turns > 0 || row.runs === 0
        ? [pluralCommas(row.turns, "turn", "turns")]
        : []),
      ...(row.runs > 0 ? [pluralCommas(row.runs, "run", "runs")] : []),
    ].join(" · ");
    return {
      key: row.id ?? (row.deleted ? "deleted" : `${row.owner ?? "row"}-${i}`),
      name,
      mono: kind === "agents",
      note: row.deleted && kind === "agents" ? "deleted" : undefined,
      ...barOf(row, priced),
      hint,
    };
  });
}

// without its org, unless what is left is a bare word ("openrouter/free")
export function modelLabel(model: string): string {
  const rest = model.slice(model.lastIndexOf("/") + 1);
  return /[\d-]/.test(rest) ? rest : model;
}

export function modelBars(rows: ModelUsage[]) {
  const total = tokensSum(rows);
  const priced = rows.some((row) => row.cost !== null);
  // two deleted providers may share a model, so a gone one keys by place
  return rows.map((row, i) => ({
    key: `${row.provider ?? `gone-${i}`}/${row.model}`,
    name: modelLabel(row.model),
    mono: true,
    ...barOf(row, priced),
    hint: [row.provider ?? "deleted provider", share(row.tokens, total)].join(
      " · ",
    ),
  }));
}

export function agentBars(agents: UsageRow[], deciders: DeciderUsage[]) {
  const total = tokensSum(agents) + tokensSum(deciders);
  const priced =
    agents.some((row) => row.cost !== null) ||
    deciders.some((row) => row.cost !== null);
  const decided = deciders.map((row) => ({
    key: `decider-${row.name}`,
    name: row.name,
    mono: true,
    note: "decider",
    ...barOf(row, priced),
    hint: [
      share(row.tokens, total),
      pluralCommas(row.decisions, "decision", "decisions"),
    ].join(" · "),
  }));
  return [...rowBars("agents", agents, total, priced), ...decided].sort(
    (a, b) => b.value - a.value,
  );
}
