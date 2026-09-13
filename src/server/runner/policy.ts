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

import type { AgentRow } from "../agents/index.ts";
import type { Limits, LoopLimits } from "../limits/index.ts";
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
  offered(now: number): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
};

export type SendPolicy = {
  projectId: string;
  userId: string;
  username: string;
  fullName: string;
  about: string;
  agentId: string;
  agentName: string;
  providerId: string;
  model: string;
  contextLength: number | null;
  prompt: string;
  thinking: boolean;
  // the snapshot the send runs under, its tools the schemas on the wire
  offered: Offered;
  // the caps the send started on, the limits area's word at that moment
  limits: LoopLimits;
  toolCaps: ToolCaps;
};

const NONE: Offered = { tools: [], search: null };

export function buildPolicy(input: {
  projectId: string;
  user: UserRow;
  agent: AgentRow;
  now: number;
  // the tools area, or none when the model does not accept tools; the
  // one place the set is decided
  tools: ToolsPort | null;
  limits: Limits;
}): SendPolicy {
  const { user, agent } = input;
  const offered =
    input.tools !== null && agent.model.tools
      ? input.tools.offered(input.now)
      : NONE;
  return {
    projectId: input.projectId,
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    about: user.about,
    agentId: agent.id,
    agentName: agent.name,
    providerId: agent.providerId,
    model: agent.model.id,
    contextLength: agent.model.contextLength,
    prompt: agent.prompt,
    thinking: agent.model.reasoning,
    offered,
    limits: {
      rounds: input.limits.rounds,
      callsPerRound: input.limits.callsPerRound,
      callsPerSend: input.limits.callsPerSend,
      toolMs: input.limits.toolMs,
      resultBytes: input.limits.resultBytes,
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
