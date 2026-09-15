// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a built-in tool is and what it is handed. The runner never sees
// these: it holds the schemas and the search provider the area offered,
// and calls run() with a ToolCall and the send's counters and caps. A
// tool reads only its ToolContext; the key it needs is read by the area
// from the secrets port, never carried here.

import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { ToolCaps } from "../limits/index.ts";
import type { ChatTool } from "../providers/index.ts";

export type { ToolCaps } from "../limits/index.ts";

// what a send may spend across its tools, mutated in place as the send
// runs so a cap holds across parallel calls in one round
export type ToolBudget = {
  // webfetch calls this send
  fetches: number;
  // websearch calls this send
  searches: number;
};

export type ToolContext = {
  // the send's signal; a stop, a shutdown or a cap aborts it
  signal: AbortSignal;
  now(): number;
  budget: ToolBudget;
  caps: ToolCaps;
};

// what a tool run gives back: the text the model gets and whether it was
// an error. A tool that throws is turned into an error result by the
// area, never a rejection the runner must catch.
export type ToolResult = { content: string; error: boolean };

export type Tool = {
  name: string;
  description: string;
  parameters: object;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
};

// what a send is offered once, on the policy: the schemas the model gets
// and the search provider chosen for its life, or null when no chosen
// provider has a key
export type Offered = {
  tools: ChatTool[];
  search: "exa" | "firecrawl" | null;
  skills: { block: string; skills: OfferedSkill[] };
};
