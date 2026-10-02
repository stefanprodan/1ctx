// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a built-in tool is and what it is handed. The runner holds one
// offered snapshot and calls run() with its counters and caps.

import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type { SearchProvider } from "../../shared/words.ts";
import type {
  CommandEnd,
  JobRepo,
  KeptFile,
  OpenedRecord,
} from "../bash/index.ts";
import type { CredentialRow } from "../credentials/index.ts";
import type { ToolCaps } from "../limits/index.ts";
import type { OfferedServer } from "../mcp/index.ts";
import type {
  ChatEditAnswer,
  ChatMemoryEdit,
  MemoryWork,
} from "../memory/index.ts";
import type { ChatTool } from "../providers/index.ts";

export type { ToolCaps } from "../limits/index.ts";

export type ToolBudget = {
  bashCalls: number;
  fetches: number;
  searches: number;
  visualBytes: number;
  visuals: number;
};

// A send that offers bash keeps MCP results past the cut under /mcp:
// take() hands out the next folder number; used and files count the
// chat's kept bytes and files, this send's included, against maxBytes
// and maxFiles.
export type KeepPort = {
  take(): number;
  maxBytes: number;
  used: number;
  maxFiles: number;
  files: number;
};

// The repositories a send mounted for each of its commands, under
// /repos, and the caps it started on. notice() hands out what was left
// out once, to the first command.
export type SendRepos = {
  mounts: readonly JobRepo[];
  fileBytes: number;
  notice(): string;
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
  keep?: KeepPort | null;
  repos?: SendRepos | null;
};

export type ToolResult = {
  content: string;
  error: boolean;
  tail?: number;
  opened?: OpenedRecord[];
  // the /knowledge paths a bash command wrote, stored on its row
  saved?: string[];
  // MCP results and resources kept under /mcp, written with the row
  kept?: KeptFile[];
  // Kept in memory for the log and deliberately omitted from stored rows.
  failure?: unknown;
  timedOut?: boolean;
  // where a bash command that saved nothing ended, for the log; finishTool
  // stores fields by name, so it never reaches a row
  ended?: CommandEnd;
};

export type Tool<T extends string | ToolResult = string> = {
  name: string;
  description: string;
  parameters: object;
  timeoutMs?: number;
  /** time past the timeout to answer at its own deadline, before it is cut */
  graceMs?: number;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<T>;
};

export type MemoryScope = {
  projectId: string | null;
  automation: {
    id: string;
    ownMemory: boolean;
  } | null;
  phase: "main" | "memory";
  // the chat a main round saves from; absent for a run and a compaction
  chat?: { sessionId: string; userId: string } | null;
};

// a chat's saves, bound to its project, session and author
export type ChatMemoryPort = {
  edit(edit: ChatMemoryEdit): ChatEditAnswer;
  refuse(reason: string): string;
};

export type MemoryHandle = {
  // the own-note phase's working copy, null in a chat
  work: MemoryWork | null;
  chat: ChatMemoryPort | null;
  // a chat's set refused for a conflict, by folded topic: the same text
  // again is the merge not done
  refused: Map<string, string>;
  queue: Promise<void>;
  stopped: boolean;
  recordEdit(success: boolean): void;
  settleRound(): void;
};

// a credential of the send's project, as the send began: the key is
// read again by name at each command
export type OfferedCredential = Pick<
  CredentialRow,
  "id" | "name" | "keyName" | "prefix" | "header" | "template" | "methods"
>;

export type Offered = {
  tools: ChatTool[];
  visuals: boolean;
  // false while the send has the project docs off
  knowledge: boolean;
  web: WebSnapshot | null;
  search: SearchProvider | null;
  skills: { block: string; skills: OfferedSkill[] };
  mcp: OfferedServer[];
  mcpPrompt: { text: string; digest: McpDigest };
  mcpCatalog: string;
  memory: MemoryHandle | null;
  // the project's credentials, in name order, empty without network;
  // those the send turned off kept apart, so a command refuses them by
  // name
  credentials: OfferedCredential[];
  credentialsOff: { id: string; name: string; prefix: string }[];
};
