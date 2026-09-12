// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a send runs under, decided once before startSend and never
// changed: the author, the project, the agent with its provider and
// model, and the tools. The authorized tool set is empty until the
// tools slice fills it here and nowhere else.

import type { AgentRow } from "../agents/index.ts";
import type { ChatTool } from "../providers/index.ts";
import type { UserRow } from "../users/index.ts";

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
  tools: ChatTool[];
};

export function buildPolicy(input: {
  projectId: string;
  user: UserRow;
  agent: AgentRow;
}): SendPolicy {
  const { user, agent } = input;
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
    tools: [],
  };
}
