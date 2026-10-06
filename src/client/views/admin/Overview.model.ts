// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AttentionItem,
  AttentionKind,
  AttentionResponse,
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
  money,
  plural,
  pluralCommas,
  share,
  size,
  sizeParts,
} from "../../lib/format.ts";
import {
  configCredentialHref,
  configMcpHref,
  configProviderHref,
  configSkillHref,
  SMTP_HREF,
  WEB_HREF,
} from "../../lib/hrefs.ts";

const MEMORY_FULL = 0.8;

export const tokensOf = (t: {
  promptTokens: number;
  completionTokens: number;
}): number => t.promptTokens + t.completionTokens;

function slots(running: number, cap: number, sub: string) {
  return {
    figure: String(running),
    unit: `/ ${cap} slots`,
    sub,
    share: cap > 0 ? running / cap : 0,
    full: cap > 0 && running >= cap,
  };
}

// every chat and run against the process's cap
export const runningTile = (load: LoadResponse) =>
  slots(
    load.chats + load.runs,
    load.cap,
    [
      pluralCommas(load.chats, "chat", "chats"),
      pluralCommas(load.runs, "run", "runs"),
      pluralCommas(load.online, "user online", "users online"),
    ].join(" · "),
  );

// the scheduled runs against their share of the process
export const automationsTile = (load: LoadResponse) =>
  slots(
    load.scheduled,
    load.scheduledCap,
    [
      pluralCommas(load.automations, "automation", "automations"),
      ...(load.waiting > 0 ? [`${load.waiting} waiting`] : []),
      ...(load.projectsFull > 0
        ? [pluralCommas(load.projectsFull, "project full", "projects full")]
        : []),
    ].join(" · "),
  );

export const percent = (cpu: number): string => `${Math.round(cpu * 100)}%`;

export function cpuTile(load: LoadResponse) {
  return {
    figure: percent(load.samples.cpu.at(-1) ?? 0),
    sub: `of ${pluralCommas(load.cores, "core", "cores")}`,
  };
}

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

export const sampleLine = (at: number, words: string): string =>
  `${clock(at)} · ${words}`;

// room around the window, so a steady process draws through the middle
// and a climb leaves the top; a flat window gets 2% either side
export function zoomed(min: number, max: number): [number, number] {
  const pad = Math.max((max - min) * 0.3, max * 0.02);
  return [Math.max(0, min - pad), max + pad];
}

export const staleWords = (at: number | null): string =>
  at === null ? "Did not load" : `Not updated since ${clock(at)}`;

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

// Usage has no Decisions tile, so its decisions ride with the runs
export function runsTile(totals: OverviewTotals, at: OverviewDay | null) {
  const t = at ?? totals;
  const line = at
    ? pluralCommas(at.runs, "run", "runs") + failedOn(at.runsFailed)
    : failedLine(totals.runsFailed, totals.runs);
  const words =
    t.decisions > 0
      ? `${line} · ${pluralCommas(t.decisions, "decision", "decisions")}`
      : line;
  return {
    figure: commas(totals.runs),
    unit: totals.runs === 1 ? "run" : "runs",
    sub: at ? onDay(at, words) : words,
  };
}

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

function cachedLine(t: OverviewTotals): string {
  if (t.promptTokens === 0) return "none yet";
  return `${share(t.cachedTokens, t.promptTokens)} cached`;
}

export function tokensTile(totals: OverviewTotals, at: OverviewDay | null) {
  return {
    figure: count(tokensOf(totals)),
    sub: at ? onDay(at, count(tokensOf(at))) : cachedLine(totals),
  };
}

// a null counts as 0 beside a priced one; both null is no price at all
export function costOf(t: {
  cost: number | null;
  decisionCost: number | null;
}): number | null {
  if (t.cost === null && t.decisionCost === null) return null;
  return (t.cost ?? 0) + (t.decisionCost ?? 0);
}

// never $0 where no provider priced either
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

export const tokensHint = (t: OverviewTotals): string =>
  `${count(tokensOf(t))} tokens`;

export function dayTokensHint(day: OverviewDay): string {
  const parts = [dayMonth(day.start), `${count(tokensOf(day))} tokens`];
  if (day.promptTokens > 0) {
    parts.push(`${share(day.cachedTokens, day.promptTokens)} cached`);
  }
  return parts.join(" · ");
}

export const buildLine = (
  instance: OverviewResponse["instance"],
  now: number,
): string => `${instance.version} · up ${elapsed(now - instance.startedAt)}`;

const ATTENTION: Record<
  AttentionKind,
  {
    what: string;
    line: string;
    icon: "mcp" | "skill" | "key" | "email";
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
    what: "MCP Server",
    line: "key file missing",
    href: configMcpHref,
  },
  "credential-key": {
    icon: "key",
    what: "Credential",
    line: "key file missing",
    href: configCredentialHref,
  },
  "credential-unusable": {
    icon: "key",
    what: "Credential",
    line: "key file unusable",
    href: configCredentialHref,
  },
  "search-key": {
    icon: "key",
    what: "Web search",
    line: "key file missing",
    href: () => WEB_HREF,
  },
  "smtp-key": {
    icon: "key",
    what: "SMTP",
    line: "key file missing",
    href: () => SMTP_HREF,
  },
  "email-failed": {
    icon: "email",
    what: "Email",
    line: "failed",
    href: () => SMTP_HREF,
  },
  "mcp-refresh": {
    icon: "mcp",
    what: "MCP Server",
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

// a failed email is named by its word, with the outbox's counts
function emailLine(
  at: number,
  now: number,
  email: AttentionResponse["email"],
): string {
  const failed = email?.failed ?? 1;
  const queued = email?.queued ?? 0;
  const line = `${plural(failed, "email")} failed, the last ${ago(at, now)}`;
  return queued > 0 ? `${line}, ${count(queued)} queued` : line;
}

export function attentionRow(
  item: AttentionItem,
  now: number,
  email: AttentionResponse["email"] = null,
) {
  const words = ATTENTION[item.kind];
  return {
    key: `${item.kind}:${item.name}`,
    name: item.name,
    line:
      item.at === null
        ? words.line
        : item.kind === "email-failed"
          ? emailLine(item.at, now, email)
          : `${words.line} ${ago(item.at, now)}`,
    what: words.what,
    icon: words.icon,
    href: words.href(item.name),
  };
}
