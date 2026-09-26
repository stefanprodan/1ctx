// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a user's page and an agent's page.

import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
} from "../../../shared/api/directory.ts";
import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { Role } from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";
import { agentHref } from "../../lib/hrefs.ts";
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

// the tools that reach the model and the sides the agent may use
export function serverMeta(server: {
  read: boolean;
  write: boolean;
  tools: number;
}): string {
  const n = server.tools;
  const sides =
    server.read && server.write
      ? "read and write"
      : server.read
        ? "read"
        : "write";
  return `${n} tool${n === 1 ? "" : "s"} · ${sides} access`;
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

// the tab an address is on, by its place in the tabs: the prompt's
// for the page's own address or any other
export function agentTab(pathname: string, name: string): number {
  const base = agentHref(name);
  const at = AGENT_TABS.findIndex((tail) => pathname === `${base}${tail}`);
  return at === -1 ? 0 : at;
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
