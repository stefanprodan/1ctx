// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a user's page and an agent's page.

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { Role } from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";
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
