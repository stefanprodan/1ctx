// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Overview's words and numbers, pure: the Now tiles from the load,
// the last 30 days' tiles and a day's words, the bars of a breakdown
// and of the turn lengths, all time, and the faint lines. A chat's send
// is a turn and a task's a run; "send" is never shown.

import type {
  LoadResponse,
  OverviewDay,
  OverviewResponse,
  OverviewTotals,
  TurnLength,
  UsageBy,
  UsageRow,
} from "../../../shared/api/admin.ts";
import {
  clock,
  commas,
  count,
  dayMonth,
  elapsed,
  pluralCommas,
  share,
  size,
  sizeParts,
} from "../../lib/format.ts";

// a container's memory past this share is marked
const MEMORY_FULL = 0.8;

// "$4.12", "<$0.01" for a cost that is there but under a cent
export function money(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export const tokensOf = (t: {
  promptTokens: number;
  completionTokens: number;
}): number => t.promptTokens + t.completionTokens;

// a pool's tile: the sends running against the process's cap
function pool(running: number, cap: number, sub: string) {
  return {
    figure: String(running),
    unit: `/ ${cap} slots`,
    sub,
    share: cap > 0 ? running / cap : 0,
    full: cap > 0 && running >= cap,
  };
}

export const chatTile = (load: LoadResponse) =>
  pool(
    load.chats,
    load.chatsCap,
    pluralCommas(load.online, "user online", "users online"),
  );

export const automationsTile = (load: LoadResponse) =>
  pool(
    load.runs,
    load.runsCap,
    [
      pluralCommas(load.automations, "automation", "automations"),
      ...(load.waiting > 0 ? [`${load.waiting} waiting`] : []),
    ].join(" · "),
  );

export const percent = (cpu: number): string => `${Math.round(cpu * 100)}%`;

export function cpuTile(load: LoadResponse) {
  return {
    figure: percent(load.samples.cpu.at(-1) ?? 0),
    sub: `of ${pluralCommas(load.cores, "core", "cores")}`,
  };
}

// memory against the host's, or a container's limit with a meter
export function memoryTile(load: LoadResponse) {
  const rss = load.samples.rss.at(-1) ?? 0;
  const parts = sizeParts(rss);
  const used = load.memoryLimit > 0 ? rss / load.memoryLimit : 0;
  return {
    figure: parts.figure,
    unit: parts.unit,
    sub: load.contained
      ? `of ${size(load.memoryLimit)} limit`
      : `of ${size(load.memoryLimit)}`,
    share: used,
    full: load.contained && used >= MEMORY_FULL,
  };
}

// a sample under the cursor: "11:32 · 4%"
export const sampleLine = (at: number, words: string): string =>
  `${clock(at)} · ${words}`;

// The memory line's scale: the window's lowest to highest with room
// around it, so a steady process draws through the middle and a climb
// leaves the top; a flat window gets 2% either side.
export function zoomed(min: number, max: number): [number, number] {
  const pad = Math.max((max - min) * 0.3, max * 0.02);
  return [Math.max(0, min - pad), max + pad];
}

// a row whose read failed: since when its numbers are, or that there
// are none yet
export const staleWords = (at: number | null): string =>
  at === null ? "Did not load" : `Not updated since ${clock(at)}`;

// "1% failed", or that there was none
function failedLine(failed: number, of: number): string {
  if (of === 0) return "none yet";
  return failed === 0 ? "none failed" : `${share(failed, of)} failed`;
}

const onDay = (day: OverviewDay, words: string) =>
  `${dayMonth(day.start)} · ${words}`;

const failedOn = (failed: number) => (failed > 0 ? ` · ${failed} failed` : "");

export function turnsTile(totals: OverviewTotals, at: OverviewDay | null) {
  return {
    figure: commas(totals.turns),
    unit: totals.turns === 1 ? "turn" : "turns",
    sub: at
      ? onDay(
          at,
          pluralCommas(at.turns, "turn", "turns") + failedOn(at.turnsFailed),
        )
      : failedLine(totals.turnsFailed, totals.turns),
  };
}

export function runsTile(totals: OverviewTotals, at: OverviewDay | null) {
  return {
    figure: commas(totals.runs),
    unit: totals.runs === 1 ? "run" : "runs",
    sub: at
      ? onDay(
          at,
          pluralCommas(at.runs, "run", "runs") + failedOn(at.runsFailed),
        )
      : failedLine(totals.runsFailed, totals.runs),
  };
}

// how much of the input a cache served
export function cachedLine(t: OverviewTotals): string {
  if (t.promptTokens === 0) return "none yet";
  return `${share(t.cachedTokens, t.promptTokens)} cached`;
}

export function tokensTile(totals: OverviewTotals, at: OverviewDay | null) {
  return {
    figure: count(tokensOf(totals)),
    sub: at ? onDay(at, count(tokensOf(at))) : cachedLine(totals),
  };
}

// the cost: never $0 where no provider priced a round
function costWords(t: OverviewTotals) {
  if (t.rounds === 0) return { figure: "None", sub: "none yet" };
  if (t.cost === null) return { figure: "None", sub: "no provider priced" };
  return {
    figure: money(t.cost),
    sub: `${commas(t.pricedRounds)} of ${commas(t.rounds)} priced`,
  };
}

export function costTile(totals: OverviewTotals, at: OverviewDay | null) {
  const words = costWords(totals);
  return at && totals.cost !== null
    ? { ...words, sub: onDay(at, money(at.cost ?? 0)) }
    : words;
}

// the tokens chart's hint, at rest and on a day
export const tokensHint = (t: OverviewTotals): string =>
  `${count(tokensOf(t))} tokens`;

export function dayTokensHint(day: OverviewDay): string {
  const parts = [dayMonth(day.start), `${count(tokensOf(day))} tokens`];
  if (day.promptTokens > 0) {
    parts.push(`${share(day.cachedTokens, day.promptTokens)} cached`);
  }
  return parts.join(" · ");
}

// A breakdown's row as a bar: a personal project by its owner, a team
// project by its name, an agent in mono. The hint says only what the
// bar does not: the share and what ran.
export function usageBars(kind: UsageBy, rows: UsageRow[]) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row, i) => {
    const name =
      row.owner !== null
        ? `@${row.owner}`
        : kind === "projects"
          ? `#${row.name ?? ""}`
          : (row.name ?? "");
    const hint = [
      share(row.tokens, total),
      ...(row.turns > 0 || row.runs === 0
        ? [pluralCommas(row.turns, "turn", "turns")]
        : []),
      ...(row.runs > 0 ? [pluralCommas(row.runs, "run", "runs")] : []),
    ].join(" · ");
    return {
      key: row.id ?? `${row.owner ?? "row"}-${i}`,
      name,
      mono: kind === "agents",
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

// all time's four figures
export function allCells(all: OverviewResponse["all"]) {
  return [
    {
      label: "Chats",
      figure: commas(all.turns),
      unit: all.turns === 1 ? "turn" : "turns",
      sub: failedLine(all.turnsFailed, all.turns),
    },
    {
      label: "Automations",
      figure: commas(all.runs),
      unit: all.runs === 1 ? "run" : "runs",
      sub: failedLine(all.runsFailed, all.runs),
    },
    { label: "Tokens", figure: count(tokensOf(all)), sub: cachedLine(all) },
    { label: "Cost", ...costWords(all) },
  ];
}

export const sinceWords = (since: number | null): string =>
  since === null ? "" : `since ${dayMonth(since)}`;

// all time's foot, before the database's size, which is its own link;
// each part is kept whole where the line breaks
export function instanceParts(
  instance: OverviewResponse["instance"],
): string[] {
  return [
    pluralCommas(instance.users, "user", "users"),
    pluralCommas(instance.agents, "agent", "agents"),
    pluralCommas(instance.projects, "team project", "team projects"),
    pluralCommas(instance.automations, "automation", "automations"),
  ];
}

export const databaseWords = (bytes: number): string =>
  `database ${size(bytes)}`;

// the build and how long it has been up
export const buildLine = (
  instance: OverviewResponse["instance"],
  now: number,
): string => `${instance.version} · up ${elapsed(now - instance.startedAt)}`;
