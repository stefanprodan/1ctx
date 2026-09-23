// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Overview's words and numbers, pure: the tiles' figures and lines,
// a day's words, the bars of a breakdown and of the models, and the
// instance's line.

import type {
  ModelHealth,
  OverviewDay,
  OverviewResponse,
  OverviewTotals,
  UsageBy,
  UsageRow,
} from "../../../shared/api/admin.ts";
import { count, elapsed } from "../../lib/format.ts";
import { dayWord, share, size } from "./Storage.model.ts";

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

// "$4.12", "<$0.01" for a cost that is there but under a cent
export function money(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export const tokensOf = (t: {
  promptTokens: number;
  completionTokens: number;
}): number => t.promptTokens + t.completionTokens;

// against the range before: "+12% on the 30 days before", or what
// there was when a share would mislead
export function change(now: number, before: number, days: number): string {
  const range = `the ${days} days before`;
  if (before === 0) return now === 0 ? `none ${range} either` : `none ${range}`;
  const delta = Math.round(((now - before) / before) * 100);
  if (delta === 0) return `same as ${range}`;
  return `${delta > 0 ? "+" : ""}${delta}% on ${range}`;
}

// the sends tile's line: the failed share, then the change
export function sendsLine(
  totals: OverviewTotals,
  before: OverviewTotals,
  days: number,
): string {
  const failed =
    totals.failed === 0
      ? "none failed"
      : `${share(totals.failed, totals.sends)} failed`;
  return `${failed} · ${change(totals.sends, before.sends, days)}`;
}

// the tokens tile's line: how much of the prompt a cache served
export function cachedLine(totals: OverviewTotals): string {
  if (totals.promptTokens === 0) return "no prompt tokens";
  return `${share(totals.cachedTokens, totals.promptTokens)} of the prompt cached`;
}

// the cost tile: never $0 for a range no provider priced
export function costTile(totals: OverviewTotals) {
  if (totals.cost === null) {
    return {
      figure: "None",
      sub:
        totals.rounds === 0
          ? "no rounds in the range"
          : "no provider reported a cost",
    };
  }
  return {
    figure: money(totals.cost),
    sub: `${plural(totals.pricedRounds, "round", "rounds")} of ${totals.rounds.toLocaleString("en-GB")} priced`,
  };
}

// the running tile: its figure, its line and its meter
export function runningTile(now: OverviewResponse["now"]) {
  const running = now.chats + now.runs;
  const caps = now.chatsCap + now.runsCap;
  return {
    figure: String(running),
    unit: running === 1 ? "send" : "sends",
    sub: `${plural(now.chats, "chat", "chats")} of ${now.chatsCap} · ${plural(now.runs, "run", "runs")} of ${now.runsCap} · ${now.online} online`,
    share: caps > 0 ? running / caps : 0,
  };
}

// the words of a day under the cursor
export function dayLine(day: OverviewDay): string {
  const tokens = tokensOf(day);
  const parts = [dayWord(day.start), `${count(tokens)} tokens`];
  if (day.promptTokens > 0) {
    parts.push(`${share(day.cachedTokens, day.promptTokens)} cached`);
  }
  parts.push(plural(day.sends, "send", "sends"));
  if (day.failed > 0) parts.push(`${day.failed} failed`);
  return parts.join(" · ");
}

// the range's words when no day is under the cursor
export function rangeLine(totals: OverviewTotals): string {
  return `${count(tokensOf(totals))} tokens · ${plural(totals.sends, "send", "sends")}`;
}

// A breakdown's row as a bar: its name (a personal project's owner,
// never its name), its tokens and share of the range, and the hint.
export function usageBars(kind: UsageBy, rows: UsageRow[], total: number) {
  return rows.map((row, i) => {
    const personal = row.owner !== null;
    const name = personal
      ? kind === "tasks"
        ? `a task of @${row.owner}`
        : `personal of @${row.owner}`
      : (row.name ?? "");
    const hint = [
      row.sub && !personal ? `${name} · ${row.sub}` : name,
      plural(row.sends, "send", "sends"),
      ...(row.failed > 0 ? [`${row.failed} failed`] : []),
      ...(row.cost !== null ? [money(row.cost)] : []),
    ].join(" · ");
    return {
      key: row.id ?? `${row.owner ?? "row"}-${i}`,
      name,
      mono: kind !== "users" && !personal,
      value: row.tokens,
      tokens: count(row.tokens),
      share: share(row.tokens, total),
      hint,
    };
  });
}

// a send's length: "41s", "3m 20s", "1h 5m"
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

// the models by their median send, with what else they did in the hint
export function modelBars(models: ModelHealth[]) {
  return models.map((m) => {
    const hint = [
      `${m.model} · ${m.provider}`,
      plural(m.sends, "send", "sends"),
      m.failed > 0 ? `${share(m.failed, m.sends)} failed` : "none failed",
      ...(m.slowestMs !== null ? [`slowest ${lengthWord(m.slowestMs)}`] : []),
      ...(m.medianRounds !== null
        ? [`median ${plural(m.medianRounds, "round", "rounds")}`]
        : []),
    ].join(" · ");
    return {
      key: `${m.provider}/${m.model}`,
      name: m.model,
      value: m.medianMs ?? 0,
      label: m.medianMs === null ? "running" : lengthWord(m.medianMs),
      hint,
    };
  });
}

// the instance in one line; the database's size is its own link
export function instanceLine(
  instance: OverviewResponse["instance"],
  now: number,
): string {
  return [
    instance.version,
    `up ${elapsed(now - instance.startedAt)}`,
    plural(instance.users, "user", "users"),
    plural(instance.projects, "team project", "team projects"),
    plural(instance.agents, "agent", "agents"),
    plural(instance.tasks, "task", "tasks"),
    plural(instance.servers, "MCP server", "MCP servers"),
  ].join(" · ");
}

export const databaseWords = (bytes: number): string =>
  `database ${size(bytes)}`;
