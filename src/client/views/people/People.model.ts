// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a user's page and an agent's page.

import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { McpMode } from "../../../shared/words.ts";
import { count } from "../../lib/format.ts";
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

// "2.72k tokens": a count the server made in OpenAI's encoding
export function tokensText(n: number): string {
  return `${count(n)} token${n === 1 ? "" : "s"}`;
}

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

// the MCP card's hint: what a send resolves the mode to now, and the
// lean schemas' count against the cap that flips auto
export function mcpHint(mcp: {
  mode: McpMode;
  resolved: "all" | "catalog";
  tokens: number;
  cap: number;
}): string {
  const what =
    mcp.resolved === "catalog" ? "a catalog with two tools" : "every schema";
  const how =
    mcp.mode === "auto"
      ? `auto, ${count(mcp.tokens)} of ${count(mcp.cap)} tokens`
      : mcp.mode === "all"
        ? "all schemas"
        : "catalog";
  return `${what} · ${how}`;
}

export function sidesText(server: { read: boolean; write: boolean }): string {
  if (server.read && server.write) return "read and write";
  return server.read ? "read" : "write";
}

export function toolsCount(n: number): string {
  return `${n} tool${n === 1 ? "" : "s"}`;
}
