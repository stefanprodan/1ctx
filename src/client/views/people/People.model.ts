// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a user's page and an agent's page.

import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
} from "../../../shared/api/directory.ts";
import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import type { Role } from "../../../shared/words.ts";
import { priceLine, windowLine } from "../../agents/meta.ts";
import { ago, tokensText } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import type { Tab } from "../../ui/Tabs.tsx";
import { offsetOf } from "../../ui/Zone.model.ts";

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
export function agentLine(provider: string, model: CatalogMatch): string {
  return [
    provider,
    windowLine(model.contextLength),
    priceLine(model.promptPrice, model.completionPrice),
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

export function agentTabs(name: string, shown: DirectoryAgentResponse): Tab[] {
  const base = agentHref(name);
  return [
    { label: "Instructions", href: base },
    { label: "Tools", href: `${base}/tools`, count: shown.tools.length },
    { label: "Skills", href: `${base}/skills`, count: shown.skills.length },
    { label: "MCP", href: `${base}/mcp`, count: shown.mcp.servers.length },
  ];
}

// the person's actions as the heatmap's answer, one number a day in the
// place of turns, with no tokens
export function personAnswer(
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
