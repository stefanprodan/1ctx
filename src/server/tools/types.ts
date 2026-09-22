// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a built-in tool is and what it is handed. The runner holds one
// offered snapshot and calls run() with its counters and caps.

import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type { SearchProvider } from "../../shared/words.ts";
import type { OpenedRecord } from "../knowledge/index.ts";
import type { ToolCaps } from "../limits/index.ts";
import type { OfferedServer } from "../mcp/index.ts";
import type { MemoryWork } from "../memory/index.ts";
import type { ChatTool } from "../providers/index.ts";
import type { MemorySnapshot } from "../sessions/index.ts";

export type { ToolCaps } from "../limits/index.ts";

export type ToolBudget = {
  bashCalls: number;
  fetches: number;
  searches: number;
  visualBytes: number;
  visuals: number;
};

export type ToolContext = {
  web: WebSnapshot | null;
  actor: {
    projectId: string;
    userId: string;
    agentId: string;
    agentName: string;
    sessionId: string;
    origin: "chat" | "automation";
  } | null;
  signal: AbortSignal;
  now(): number;
  budget: ToolBudget;
  caps: ToolCaps;
};

export type ToolResult = {
  content: string;
  error: boolean;
  tail?: number;
  opened?: OpenedRecord[];
};

export type Tool<T extends string | ToolResult = string> = {
  name: string;
  description: string;
  parameters: object;
  timeoutMs?: number;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<T>;
};

export type MemoryScope = {
  projectId: string | null;
  automation: {
    id: string;
    projectMemory: boolean;
    ownMemory: boolean;
  } | null;
  phase: "main" | "memory";
};

export type MemoryHandle = {
  note: "project" | "automation";
  work: MemoryWork;
  read: {
    projectId: string;
    automationId: string;
    pending: Map<string, number>;
    marks: Map<string, { readActivityAt: number; operation: number }>;
    snapshot: (MemorySnapshot & { cursor: number }) | null;
  } | null;
  queue: Promise<void>;
  stopped: boolean;
  recordEdit(success: boolean): void;
  settleRound(): void;
};

export type Offered = {
  tools: ChatTool[];
  visuals: boolean;
  web: WebSnapshot | null;
  search: SearchProvider | null;
  skills: { block: string; skills: OfferedSkill[] };
  mcp: OfferedServer[];
  mcpPrompt: { text: string; digest: McpDigest };
  mcpCatalog: string;
  memory: MemoryHandle | null;
};
