// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a built-in tool is and what it is handed. The runner never sees
// these: it holds the schemas and the search provider the area offered,
// and calls run() with a ToolCall and the send's counters and caps. A
// tool reads only its ToolContext; the key it needs is read by the area
// from the secrets port, never carried here.

import type { ChatTool } from "../providers/index.ts";

// what a send may spend across its tools, mutated in place as the send
// runs so a cap holds across parallel calls in one round
export type ToolBudget = {
  // webfetch calls this send
  fetches: number;
  // websearch calls this send
  searches: number;
};

// the tool caps a send runs under; the runner passes a copy so tools/
// never imports runner/
export type ToolCaps = {
  // the per-call wall clock, on top of the send's own signal
  callTimeoutMs: number;
  // the characters a result is cut to before it reaches the model
  resultCut: number;
  // the fetch and search budgets per send
  maxFetches: number;
  maxSearches: number;
  // the byte caps a fetch and a search body are read to
  fetchBodyBytes: number;
  searchBodyBytes: number;
  // the per-request deadlines the two tools reach under
  fetchDeadlineMs: number;
  searchDeadlineMs: number;
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
// and the search provider chosen for its life, or null when no key was
// found and websearch is not offered
export type Offered = {
  tools: ChatTool[];
  search: "exa" | "firecrawl" | null;
};
