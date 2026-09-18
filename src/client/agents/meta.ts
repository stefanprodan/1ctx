// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on an agent row: the model's window and prices and the
// agent's thinking level, shared by the admin page and the row.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";

// "128k", "1M"; empty when the catalog did not say
export function windowLine(contextLength: number | null): string {
  if (contextLength === null) return "";
  if (contextLength >= 1_000_000) {
    return `${Math.round(contextLength / 100_000) / 10}M`;
  }
  return `${Math.round(contextLength / 1000)}k`;
}

const money = (n: number) => `$${Number(n.toPrecision(3))}`;

// "$0.14 / $0.28" per million tokens, "free" when both are zero, empty
// when the catalog did not say
export function priceLine(
  promptPrice: number | null,
  completionPrice: number | null,
): string {
  if (promptPrice === null || completionPrice === null) return "";
  if (promptPrice === 0 && completionPrice === 0) return "free";
  return `${money(promptPrice)} / ${money(completionPrice)}`;
}

// "1M · $0.15 / $0.6 · tools · reasoning": what a row says about a
// model, only the parts the catalog gave
export function modelMeta(m: CatalogMatch): string {
  return [
    windowLine(m.contextLength),
    priceLine(m.promptPrice, m.completionPrice),
    m.tools ? "tools" : "",
    m.reasoning ? "reasoning" : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

// "thinking off", "effort high": only what is off the default
export function thinkingLine(
  agent: Pick<AgentSummary, "thinking" | "effort">,
): string {
  return [
    agent.thinking === null ? "" : `thinking ${agent.thinking}`,
    agent.effort === null || agent.thinking === "off"
      ? ""
      : `effort ${agent.effort}`,
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

// "2 MCPs": what the row says of the agent's MCP servers, empty for none
export function serversLine(agent: Pick<AgentSummary, "servers">): string {
  const n = agent.servers.length;
  return n === 0 ? "" : `${n} MCP${n === 1 ? "" : "s"}`;
}

// "2 skills": what the row says of the agent's skills, empty for none
export function skillsLine(agent: Pick<AgentSummary, "skills">): string {
  const n = agent.skills.length;
  return n === 0 ? "" : `${n} skill${n === 1 ? "" : "s"}`;
}

// the model's own name, the org before the slash gone: what a narrow
// line shows when "org/name" does not fit
export function shortModel(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
