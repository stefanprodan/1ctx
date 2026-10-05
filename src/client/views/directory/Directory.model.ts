// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on the Directory, a user's, an agent's and a decider's
// page.

import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryDecider,
  DirectoryDeciderDaysResponse,
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
} from "../../../shared/api/directory.ts";
import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import type { Role } from "../../../shared/words.ts";
import { priceLine, windowLine } from "../../agents/meta.ts";
import { ago, tokensText } from "../../lib/format.ts";
import {
  agentHref,
  DIRECTORY_AGENTS_HREF,
  DIRECTORY_DECIDERS_HREF,
  DIRECTORY_HREF,
  userHref,
} from "../../lib/hrefs.ts";
import type { Tab } from "../../ui/Tabs.tsx";
import { offsetOf } from "../../ui/Zone.model.ts";
import { inputPriceLine } from "../admin/Deciders.model.ts";

// "16:34 · GMT+3": the time where the user is, and how far that is from
// UTC; the time alone when the runtime does not know the zone
export function localTime(tz: string, now: number): string {
  let time: string;
  try {
    time = new Date(now).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
    });
  } catch {
    return "";
  }
  const offset = offsetOf(tz, now);
  return offset === "" ? time : `${time} · ${offset}`;
}

export const roleWords = (role: Role) =>
  role === "admin" ? "Admin" : "Member";

// "on", "off", or what the provider does by default
export function thinkingText(agent: Pick<AgentSummary, "thinking">): string {
  return agent.thinking ?? "model default";
}

export function effortText(
  agent: Pick<AgentSummary, "thinking" | "effort">,
): string {
  if (agent.thinking === "off") return "none";
  return agent.effort ?? "provider default";
}

// under a server's name: when its list was last discovered, or the
// failure since, in red, as the MCP page's row head says it
export function serverLine(
  server: { checkedAt: number; refreshFailedAt: number | null },
  now: number,
): { text: string; bad: boolean } {
  if (server.refreshFailedAt !== null) {
    return {
      text: `refresh failed ${ago(server.refreshFailedAt, now)}`,
      bad: true,
    };
  }
  return { text: `refreshed ${ago(server.checkedAt, now)}`, bad: false };
}

// what a server gives the model: its tools that reach it
export function serverMeta(server: { tools: number }): string {
  const n = server.tools;
  return `${n} tool${n === 1 ? "" : "s"}`;
}

// what a skill holds, SKILL.md counted
export function filesText(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

// under the model's name: the provider, the context and the price when
// the catalog knows them
export function agentLine(
  provider: string,
  model: CatalogMatch,
  isDefault = false,
): string {
  return [
    provider,
    windowLine(model.contextLength),
    priceLine(model.promptPrice, model.completionPrice),
    isDefault ? "default" : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

// what the model can do besides text, or that it does text alone
export function capabilities(
  model: Pick<CatalogMatch, "tools" | "reasoning">,
): string {
  const can = [model.tools ? "tools" : "", model.reasoning ? "reasoning" : ""]
    .filter((s) => s !== "")
    .join(" · ");
  return can === "" ? "text only" : can;
}

// the agent's one series as the heatmap's answer, keyed by the agent,
// so the card draws it as the Projects page draws the projects' sum
export function agentAnswer(
  body: DirectoryAgentDaysResponse,
  agentId: string,
): DaysUsageResponse {
  return {
    since: body.since,
    until: body.until,
    days: body.days,
    total: body.total,
    projects: [{ projectId: agentId, usage: body.usage }],
  };
}

const AGENT_TABS = ["", "/tools", "/skills", "/mcp"] as const;

// the tab an address is on, by its place in the tabs: the
// instructions' for the page's own address or any other
export function agentTab(pathname: string, name: string): number {
  const base = agentHref(name);
  const at = AGENT_TABS.findIndex((tail) => pathname === `${base}${tail}`);
  return at === -1 ? 0 : at;
}

// the same tab of another agent, so the switcher keeps the tab
export function agentTabHref(name: string, tab: number): string {
  return `${agentHref(name)}${AGENT_TABS[tab] ?? ""}`;
}

export function agentTabs(name: string, shown: DirectoryAgentResponse): Tab[] {
  const base = agentHref(name);
  return [
    { label: "Prompt", href: base },
    { label: "Tools", href: `${base}/tools`, count: shown.tools.length },
    { label: "Skills", href: `${base}/skills`, count: shown.skills.length },
    { label: "MCP", href: `${base}/mcp`, count: shown.mcp.servers.length },
  ];
}

// the user's actions as the heatmap's answer, one number a day in the
// place of turns, with no tokens
export function userAnswer(
  body: DirectoryUserDaysResponse,
  userId: string,
): DaysUsageResponse {
  return {
    since: body.since,
    until: body.until,
    days: body.days,
    total: { sends: body.total, tokens: 0 },
    projects: [
      {
        projectId: userId,
        usage: body.usage.map((n) => ({ sends: n, tokens: 0 })),
      },
    ],
  };
}

const USER_TABS = ["", "/projects"] as const;

// the tab an address is on: About for the page's own address or any
// other
export function userTab(pathname: string, username: string): number {
  const base = userHref(username);
  const at = USER_TABS.findIndex((tail) => pathname === `${base}${tail}`);
  return at === -1 ? 0 : at;
}

// the same tab of another user, so the switcher keeps the tab
export function userTabHref(username: string, tab: number): string {
  return `${userHref(username)}${USER_TABS[tab] ?? ""}`;
}

export function userTabs(
  username: string,
  shown: DirectoryUserResponse,
): Tab[] {
  const base = userHref(username);
  return [
    { label: "About", href: base },
    {
      label: "Projects",
      href: `${base}/projects`,
      count: shown.projects.length,
    },
  ];
}

// the head's hint for the tab on screen: what the model reads of it in
// tokens, nothing when the tab is empty
export function agentHint(
  shown: DirectoryAgentResponse,
  tab: number,
): string | undefined {
  if (tab === 0) {
    return shown.agent.prompt === ""
      ? undefined
      : tokensText(shown.tokens.prompt);
  }
  if (tab === 1) {
    return shown.tools.length === 0
      ? undefined
      : tokensText(shown.tokens.tools);
  }
  if (tab === 2) {
    return shown.skills.length === 0
      ? undefined
      : tokensText(shown.tokens.skills);
  }
  return shown.mcp.servers.length === 0
    ? undefined
    : tokensText(shown.mcp.tokens);
}

export type DirectoryTab = "users" | "agents" | "deciders";

// the Directory's tab is its address: Users for /directory and any
// other
export function directoryTab(pathname: string): DirectoryTab {
  if (pathname === DIRECTORY_AGENTS_HREF) return "agents";
  if (pathname === DIRECTORY_DECIDERS_HREF) return "deciders";
  return "users";
}

export function directoryTabs(
  users: number | undefined,
  agents: number | undefined,
  deciders: number | undefined,
): Tab[] {
  return [
    { label: "Users", href: DIRECTORY_HREF, count: users },
    { label: "Agents", href: DIRECTORY_AGENTS_HREF, count: agents },
    { label: "Deciders", href: DIRECTORY_DECIDERS_HREF, count: deciders },
  ];
}

// what the Deciders tab's search reads: the name and the model
export const deciderFields = (d: { name: string; model: string }) => [
  d.name,
  d.model,
];

// under a decider's model: the provider, the window and the input
// price when the catalog knew them; a decision has no output to price
export function deciderLine(
  provider: string,
  decider: Pick<DirectoryDecider, "contextLength" | "promptPrice" | "default">,
): string {
  return [
    provider,
    windowLine(decider.contextLength),
    inputPriceLine(decider.promptPrice),
    decider.default ? "default" : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

// the decider's answers as the heatmap's answer, one answer in the
// place of a turn
export function deciderAnswer(
  body: DirectoryDeciderDaysResponse,
  deciderId: string,
): DaysUsageResponse {
  const day = (d: { answers: number; tokens: number }) => ({
    sends: d.answers,
    tokens: d.tokens,
  });
  return {
    since: body.since,
    until: body.until,
    days: body.days,
    total: day(body.total),
    projects: [{ projectId: deciderId, usage: body.usage.map(day) }],
  };
}

type SwitchItem = { id: string; label: string; href: string };

// the lists hold live actors alone, so a disabled user's page, or an
// agent's deleted while open, adds its own name to be marked current
export function switchItems(
  listed: SwitchItem[],
  shown: SwitchItem,
): SwitchItem[] {
  if (listed.some((i) => i.id === shown.id)) return listed;
  return [...listed, shown].sort((a, b) => a.label.localeCompare(b.label));
}
