// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type { SendTotalsResponse } from "../../shared/api/admin.ts";
import type {
  AgentActivity,
  AgentImpactResponse,
  AgentResponse,
  AgentsResponse,
  SaveAgentRequest,
} from "../../shared/api/agents.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { readSlot } from "./slot.ts";

export const agents = signal<AgentSummary[] | null>(null);
export const agentsError = signal<Failure | null>(null);
export const activity = signal<AgentActivity[]>([]);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  agents.value = null;
  agentsError.value = null;
  activity.value = [];
});

// a route arrival reloads and a write can land while a load is in
// flight: only the latest word for the same user lands, a failure too
let turn = 0;

export async function loadAgents(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  agentsError.value = null;
  try {
    const body = await api<AgentsResponse>("/api/agents");
    if (owner === forUser && turn === mine) {
      agents.value = body.agents;
      activity.value = body.activity;
    }
  } catch (err) {
    if (owner === forUser && turn === mine) agentsError.value = failure(err);
  }
}

export async function createAgent(
  body: SaveAgentRequest,
): Promise<AgentSummary> {
  const forUser = owner;
  const { agent } = await api<AgentResponse>("/api/agents", "POST", body);
  turn++;
  if (owner === forUser) agents.value = [...(agents.value ?? []), agent];
  if (body.default !== undefined) void loadAgents();
  return agent;
}

export async function updateAgent(
  id: string,
  body: SaveAgentRequest,
): Promise<AgentSummary> {
  const forUser = owner;
  const { agent } = await api<AgentResponse>(
    `/api/agents/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  turn++;
  if (owner === forUser) {
    agents.value = (agents.value ?? []).map((a) => (a.id === id ? agent : a));
  }
  // the mark moved, so another row's default changed with it
  if (body.default !== undefined) void loadAgents();
  return agent;
}

type Facts = {
  usage: SendTotalsResponse | null;
  impact: AgentImpactResponse | null;
};

const facts = readSlot<Facts>(async (id) => {
  const at = `/api/agents/${encodeURIComponent(id)}`;
  const [usage, impact] = await Promise.all([
    api<SendTotalsResponse>(`${at}/usage`).catch(() => null),
    api<AgentImpactResponse>(`${at}/impact`).catch(() => null),
  ]);
  return { usage, impact };
});

export const factsFor = facts.valueFor;

// the address names the agent; its facts are read by id
export async function loadFacts(name: string): Promise<void> {
  const agent = agents.value?.find((a) => a.name === name);
  if (agent !== undefined) await facts.load(agent.id);
}

export async function deleteAgent(id: string): Promise<void> {
  const forUser = owner;
  const wasDefault = agents.value?.find((a) => a.id === id)?.default ?? false;
  await api(`/api/agents/${encodeURIComponent(id)}`, "DELETE");
  turn++;
  if (owner === forUser) {
    agents.value = (agents.value ?? []).filter((a) => a.id !== id);
  }
  // the oldest left is the default now
  if (wasDefault) void loadAgents();
}
