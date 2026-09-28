// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  OverviewDay,
  OverviewTotals,
  TurnLengths,
} from "../../../shared/api/admin.ts";
import { commas, dayMonth, pluralCommas, share } from "../../lib/format.ts";

const failedOf = (t: { turnsFailed: number; runsFailed: number }) =>
  t.turnsFailed + t.runsFailed;
const ranOf = (t: { turns: number; runs: number }) => t.turns + t.runs;

// "41s", "3m 20s", "1h 5m"
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

// bottom first: what did not fail, then every failure
export function activitySeries(days: OverviewDay[]) {
  return [
    {
      label: "Chat turns",
      values: days.map((d) => d.turns - d.turnsFailed),
    },
    {
      label: "Automation runs",
      values: days.map((d) => d.runs - d.runsFailed),
    },
    {
      label: "Failed",
      values: days.map((d) => d.turnsFailed + d.runsFailed),
    },
  ];
}

export function activityHint(
  totals: OverviewTotals,
  at: OverviewDay | null,
): string {
  if (at) {
    const failed = failedOf(at);
    return [
      dayMonth(at.start),
      pluralCommas(at.turns, "turn", "turns"),
      pluralCommas(at.runs, "run", "runs"),
      ...(failed > 0 ? [`${commas(failed)} failed`] : []),
    ].join(" · ");
  }
  const all = ranOf(totals);
  const failed = failedOf(totals);
  return all === 0
    ? ""
    : `${commas(all)} · ${failed === 0 ? "none" : share(failed, all)} failed`;
}

export function lengthSeries(days: OverviewDay[]) {
  return [
    { label: "Median", values: days.map((d) => d.medianMs) },
    { label: "p95", values: days.map((d) => d.p95Ms) },
  ];
}

const lengthWords = (l: TurnLengths): string[] =>
  l.medianMs === null
    ? []
    : [
        `median ${lengthWord(l.medianMs)}`,
        `p95 ${lengthWord(l.p95Ms ?? l.medianMs)}`,
      ];

export function lengthHint(range: TurnLengths, at: OverviewDay | null): string {
  if (at) {
    const words = lengthWords(at);
    return [dayMonth(at.start), ...(words.length ? words : ["no turns"])].join(
      " · ",
    );
  }
  return lengthWords(range).join(" · ");
}

const S = 1000;
const M = 60 * S;
// round steps of time, never 50s or 1m 40s
export const LENGTH_STEPS = [
  S,
  2 * S,
  5 * S,
  10 * S,
  15 * S,
  30 * S,
  M,
  2 * M,
  5 * M,
  10 * M,
  15 * M,
  30 * M,
  60 * M,
  120 * M,
];

export const lengthAxis = (ms: number): string =>
  ms === 0 ? "0" : lengthWord(ms);

export function activeTile(
  active: number,
  users: number,
  at: OverviewDay | null,
) {
  return {
    figure: commas(active),
    unit: active === 1 ? "user" : "users",
    sub: at
      ? `${dayMonth(at.start)} · ${pluralCommas(at.activeUsers, "user", "users")}`
      : `of ${commas(users)}`,
  };
}

export function failureTile(totals: OverviewTotals, at: OverviewDay | null) {
  const figure = share(failedOf(totals), ranOf(totals));
  if (at) {
    const failed = failedOf(at);
    return {
      figure,
      sub: `${dayMonth(at.start)} · ${
        failed === 0
          ? "none failed"
          : `${commas(failed)} of ${commas(ranOf(at))} failed`
      }`,
    };
  }
  const failed = failedOf(totals);
  return {
    figure,
    sub:
      ranOf(totals) === 0
        ? "none yet"
        : failed === 0
          ? "none failed"
          : pluralCommas(failed, "failure", "failures"),
  };
}

export const failureSeries = (days: OverviewDay[]): number[] =>
  days.map((d) => (ranOf(d) === 0 ? 0 : failedOf(d) / ranOf(d)));
