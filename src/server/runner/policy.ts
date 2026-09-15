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

import type { Effort, EventSource, ProjectKind } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Limits, LoopLimits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { ToolCall } from "../providers/index.ts";
import type {
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
  offered(
    now: number,
    agentId: string,
    agentServers: AgentRow["servers"],
    mode: AgentRow["mcpMode"],
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
  model: string;
  contextLength: number | null;
  prompt: string;
  thinking: boolean;
  effort: Effort | null;
  // the snapshot the send runs under, its tools the schemas on the wire
  offered: Offered;
  automation: {
    id: string;
    name: string;
    source: EventSource;
    dueAt: number;
    tz: string;
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
};

export function buildPolicy(input: {
  project: Pick<ProjectRow, "id" | "kind" | "name" | "description">;
  user: UserRow;
  agent: AgentRow;
  now: number;
  // the tools area, or none when the model does not accept tools; the
  // one place the set is decided
  tools: ToolsPort | null;
  limits: Limits;
  automation?: SendPolicy["automation"];
  deadlineMs?: number | null;
}): SendPolicy {
  const { user, agent } = input;
  const offered =
    input.tools !== null && agent.model.tools
      ? input.tools.offered(input.now, agent.id, agent.servers, agent.mcpMode)
      : NONE;
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
    model: agent.model.id,
    contextLength: agent.model.contextLength,
    prompt: agent.prompt,
    thinking,
    effort: thinking ? agent.effort : null,
    offered,
    automation: input.automation ?? null,
    deadlineMs: input.deadlineMs ?? null,
    limits: {
      rounds: input.limits.rounds,
      callsPerRound: input.limits.callsPerRound,
      callsPerSend: input.limits.callsPerSend,
      toolMs: input.limits.toolMs,
      resultBytes: input.limits.resultBytes,
      contextReserve: input.limits.contextReserve,
      summaryMaxTokens: input.limits.summaryMaxTokens,
    },
    toolCaps: {
      callTimeoutMs: input.limits.callTimeoutMs,
      resultCut: input.limits.resultCut,
      maxFetches: input.limits.maxFetches,
      maxSearches: input.limits.maxSearches,
      fetchBodyBytes: input.limits.fetchBodyBytes,
      searchBodyBytes: input.limits.searchBodyBytes,
      fetchDeadlineMs: input.limits.fetchDeadlineMs,
      searchDeadlineMs: input.limits.searchDeadlineMs,
    },
  };
}
