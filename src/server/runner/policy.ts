// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a send runs under, decided once before startSend and never
// changed: the author, the project, the agent with its provider and
// model, the offered tools and the caps. The tool set is decided here
// and nowhere else: an agent whose model accepts tools is offered what
// the tools area answered when the send began; a model without the
// flag is offered none. The caps are the limits area's word at the
// same moment, copied onto the policy so a send runs under the caps it
// started on whatever an admin changes later.

import { mcpKey } from "../../shared/capabilities.ts";
import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import type { RecentFile } from "../../shared/knowledge.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import type {
  Effort,
  EventSource,
  ProjectKind,
  Wire,
} from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Limits, LoopLimits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { ToolCall } from "../providers/index.ts";
import type {
  MemoryScope,
  Offered,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "../tools/index.ts";
import type { UserRow } from "../users/index.ts";

export type {
  Offered,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "../tools/index.ts";

// the tools capability, as the runner sees it: a snapshot taken once
// per send, and a run per call reading the snapshot's provider key. The
// port is the runner's own interface over the area's types; compose
// passes the tools area
export type ToolsPort = {
  serverNames(links: AgentRow["servers"]): string[];
  offered(
    now: number,
    agentId: string,
    agentServers: AgentRow["servers"],
    mode: AgentRow["mcpMode"],
    scope: MemoryScope,
    disabledCapabilities?: readonly string[],
  ): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toolName?(offered: Offered, call: ToolCall): string;
};

export type SendPolicy = {
  projectId: string;
  projectName: string;
  projectKind: ProjectKind;
  projectDescription: string;
  userId: string;
  username: string;
  fullName: string;
  about: string;
  // the user's zone, so the model asks the datetime tool in it
  tz: string;
  agentId: string;
  agentName: string;
  providerId: string;
  // the provider's wire, null when its row is gone; the answer round's
  // retries depend on whether a local server caches the conversation
  wire: Wire | null;
  model: string;
  contextLength: number | null;
  prompt: string;
  thinking: boolean;
  // the agent's own Off, not a default that resolved to off
  thinkingOff: boolean;
  effort: Effort | null;
  // the snapshot the send runs under, its tools the schemas on the wire
  offered: Offered;
  disabledCapabilities: string[];
  mcpOff: string[];
  web: WebSnapshot | null;
  memoryOffered: Offered | null;
  projectMemory: MemoryEntry[];
  automationMemory: MemoryEntry[];
  knowledge: { files: number; recent: RecentFile[] };
  automation: {
    id: string;
    name: string;
    source: EventSource;
    dueAt: number;
    tz: string;
    projectMemory: boolean;
    ownMemory: boolean;
    memoryGuidance: string;
  } | null;
  deadlineMs: number | null;
  // the caps the send started on, the limits area's word at that moment
  limits: LoopLimits;
  toolCaps: ToolCaps;
};

const NONE: Offered = {
  tools: [],
  search: null,
  skills: { block: "", skills: [] },
  mcp: [],
  mcpPrompt: { text: "", digest: {} },
  mcpCatalog: "",
  memory: null,
  web: null,
};

export function buildPolicy(input: {
  project: Pick<ProjectRow, "id" | "kind" | "name" | "description">;
  user: UserRow;
  agent: AgentRow;
  wire?: Wire | null;
  now: number;
  // the tools area, or none when the model does not accept tools; the
  // one place the set is decided
  tools: ToolsPort | null;
  disabledCapabilities?: readonly string[];
  limits: Limits;
  knowledge: SendPolicy["knowledge"];
  automation?: SendPolicy["automation"];
  projectMemory?: readonly MemoryEntry[];
  automationMemory?: readonly MemoryEntry[];
  deadlineMs?: number | null;
}): SendPolicy {
  const { user, agent } = input;
  const disabledCapabilities = [...(input.disabledCapabilities ?? [])];
  const automationScope =
    input.automation === undefined || input.automation === null
      ? null
      : {
          id: input.automation.id,
          projectMemory: input.automation.projectMemory,
          ownMemory: input.automation.ownMemory,
        };
  const offered =
    input.tools !== null && agent.model.tools
      ? input.tools.offered(
          input.now,
          agent.id,
          agent.servers,
          agent.mcpMode,
          {
            projectId: input.project.id,
            automation: automationScope,
            phase: "main",
          },
          disabledCapabilities,
        )
      : NONE;
  const memoryOffered =
    input.tools !== null && agent.model.tools && automationScope?.ownMemory
      ? input.tools.offered(input.now, agent.id, agent.servers, agent.mcpMode, {
          projectId: input.project.id,
          automation: automationScope,
          phase: "memory",
        })
      : null;
  const thinking =
    agent.thinking === null ? agent.model.reasoning : agent.thinking === "on";
  return {
    projectId: input.project.id,
    projectName: input.project.name,
    projectKind: input.project.kind,
    projectDescription: input.project.description,
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    about: user.about,
    tz: user.tz,
    agentId: agent.id,
    agentName: agent.name,
    providerId: agent.providerId,
    wire: input.wire ?? null,
    model: agent.model.id,
    contextLength: agent.model.contextLength,
    prompt: agent.prompt,
    thinking,
    thinkingOff: agent.thinking === "off",
    effort: thinking ? agent.effort : null,
    offered,
    disabledCapabilities,
    mcpOff:
      input.tools !== null && agent.model.tools
        ? input.tools
            .serverNames(
              agent.servers.filter((link) =>
                disabledCapabilities.includes(mcpKey(link.serverId)),
              ),
            )
            .sort()
        : [],
    web: offered.web,
    memoryOffered,
    projectMemory: (input.projectMemory ?? []).map((entry) => ({ ...entry })),
    automationMemory: (input.automationMemory ?? []).map((entry) => ({
      ...entry,
    })),
    knowledge: {
      files: input.knowledge.files,
      recent: input.knowledge.recent.map((file) => ({ ...file })),
    },
    automation: input.automation ? { ...input.automation } : null,
    deadlineMs: input.deadlineMs ?? null,
    limits: {
      rounds: input.limits.rounds,
      callsPerRound: input.limits.callsPerRound,
      callsPerSend: input.limits.callsPerSend,
      toolMs: input.limits.toolMs,
      resultBytes: input.limits.resultBytes,
      toolWorkTokens: input.limits.toolWorkTokens,
      contextReserve: input.limits.contextReserve,
      summaryMaxTokens: input.limits.summaryMaxTokens,
      memoryPhaseMs: input.limits.memoryPhaseMs,
      memoryPhaseRounds: input.limits.memoryPhaseRounds,
    },
    toolCaps: {
      callTimeoutMs: input.limits.callTimeoutMs,
      resultCut: input.limits.resultCut,
      maxBashCalls: input.limits.maxBashCalls,
      maxFetches: input.limits.maxFetches,
      maxSearches: input.limits.maxSearches,
      fetchBodyBytes: input.limits.fetchBodyBytes,
      searchBodyBytes: input.limits.searchBodyBytes,
      fetchDeadlineMs: input.limits.fetchDeadlineMs,
      searchDeadlineMs: input.limits.searchDeadlineMs,
      visualBytes: input.limits.visualBytes,
      visualSendBytes: input.limits.visualSendBytes,
      maxVisuals: input.limits.maxVisuals,
    },
  };
}
