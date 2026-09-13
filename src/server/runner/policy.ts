// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a send runs under, decided once before startSend and never
// changed: the author, the project, the agent with its provider and
// model, the offered tools and the loop caps. The tool set is decided
// here and nowhere else: an agent whose model accepts tools is offered
// what the tools area answered when the send began; a model without the
// flag is offered none and behaves as before.

import type { AgentRow } from "../agents/index.ts";
import type { ToolCall } from "../providers/index.ts";
import {
  type Offered,
  TOOL_CAPS,
  type ToolCaps,
  type ToolContext,
  type ToolResult,
} from "../tools/index.ts";
import type { UserRow } from "../users/index.ts";
import { LOOP_LIMITS, type LoopLimits } from "./limits.ts";

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
// passes the tools area. The caps are copied onto the policy so a send
// runs under the caps it started on.
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
  // a copy of the loop and tool caps, so a send runs under the caps it
  // started on
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
    limits: { ...LOOP_LIMITS },
    toolCaps: { ...TOOL_CAPS },
  };
}
