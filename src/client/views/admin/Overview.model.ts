// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Monitor's words and numbers, pure: the Now tiles from the load,
// the days' tiles and a day's words, what needs attention, and the
// faint line. A chat's send is a turn and a task's a run;
// "send" is never shown.

import type {
  AttentionItem,
  AttentionKind,
  LoadResponse,
  OverviewDay,
  OverviewResponse,
  OverviewTotals,
} from "../../../shared/api/admin.ts";
import {
  ago,
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
import {
  configMcpHref,
  configProviderHref,
  configSkillHref,
} from "../../lib/hrefs.ts";

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

// Usage has no Decisions tile, so the decisions ride along there,
// runs being what asks them; the Monitor gives them their own
export function runsTile(
  totals: OverviewTotals,
  at: OverviewDay | null,
  withDecisions = true,
) {
  const t = at ?? totals;
  const line = at
    ? pluralCommas(at.runs, "run", "runs") + failedOn(at.runsFailed)
    : failedLine(totals.runsFailed, totals.runs);
  const words =
    withDecisions && t.decisions > 0
      ? `${line} · ${pluralCommas(t.decisions, "decision", "decisions")}`
      : line;
  return {
    figure: commas(totals.runs),
    unit: totals.runs === 1 ? "run" : "runs",
    sub: at ? onDay(at, words) : words,
  };
}

// the decisions answered and the input tokens they read
function decisionsLine(t: OverviewTotals): string {
  return t.decisions === 0 ? "none yet" : `${count(t.decisionTokens)} tokens`;
}

export function decisionsTile(totals: OverviewTotals, at: OverviewDay | null) {
  return {
    figure: commas(totals.decisions),
    unit: totals.decisions === 1 ? "decision" : "decisions",
    sub: at
      ? onDay(at, pluralCommas(at.decisions, "decision", "decisions"))
      : decisionsLine(totals),
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

// the rounds' cost and the decisions' together: a null counts as 0
// beside a priced one, and both null is no price at all
export function costOf(t: {
  cost: number | null;
  decisionCost: number | null;
}): number | null {
  if (t.cost === null && t.decisionCost === null) return null;
  return (t.cost ?? 0) + (t.decisionCost ?? 0);
}

// the cost of rounds and decisions: never $0 where no provider priced
// either
function costWords(t: OverviewTotals) {
  const asked = t.rounds + t.decisions;
  const cost = costOf(t);
  if (asked === 0) return { figure: "None", sub: "none yet" };
  if (cost === null) return { figure: "None", sub: "no provider priced" };
  return {
    figure: money(cost),
    sub: `${commas(t.pricedRounds + t.pricedDecisions)} of ${commas(asked)} priced`,
  };
}

export function costTile(totals: OverviewTotals, at: OverviewDay | null) {
  const words = costWords(totals);
  return at && costOf(totals) !== null
    ? { ...words, sub: onDay(at, money(costOf(at) ?? 0)) }
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

// the build and how long it has been up
export const buildLine = (
  instance: OverviewResponse["instance"],
  now: number,
): string => `${instance.version} · up ${elapsed(now - instance.startedAt)}`;

const ATTENTION: Record<
  AttentionKind,
  {
    what: string;
    line: string;
    icon: "mcp" | "skill" | "key";
    href: (name: string) => string;
  }
> = {
  "provider-key": {
    icon: "key",
    what: "Provider",
    line: "key file missing",
    href: configProviderHref,
  },
  "mcp-key": {
    icon: "mcp",
    what: "MCP server",
    line: "key file missing",
    href: configMcpHref,
  },
  "credential-key": {
    icon: "key",
    what: "Credential",
    line: "key file missing",
    href: () => "/config/tools/web",
  },
  "credential-unusable": {
    icon: "key",
    what: "Credential",
    line: "key file unusable",
    href: () => "/config/tools/web",
  },
  "search-key": {
    icon: "key",
    what: "Web search",
    line: "key file missing",
    href: () => "/config/tools/web",
  },
  "mcp-refresh": {
    icon: "mcp",
    what: "MCP server",
    line: "refresh failed",
    href: configMcpHref,
  },
  "skill-refresh": {
    icon: "skill",
    what: "Skill",
    line: "refresh failed",
    href: configSkillHref,
  },
};

// a row of what needs attention: the name, what failed and when, what
// kind of thing it is and its icon (an MCP server's or a skill's own,
// a key for the rest), and the page that fixes it
export function attentionRow(item: AttentionItem, now: number) {
  const words = ATTENTION[item.kind];
  return {
    key: `${item.kind}:${item.name}`,
    name: item.name,
    line: item.at === null ? words.line : `${words.line} ${ago(item.at, now)}`,
    what: words.what,
    icon: words.icon,
    href: words.href(item.name),
  };
}
