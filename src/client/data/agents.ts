// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents entity: the admin's list, loaded when its page is reached
// and dropped with the signed-in user, and the calls that change it. A write puts
// the server's row in the list, so what shows is what was saved.

import { effect, signal } from "@preact/signals";
import type {
  AgentResponse,
  AgentsResponse,
  SaveAgentRequest,
} from "../../shared/api/agents.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const agents = signal<AgentSummary[] | null>(null);
export const agentsError = signal<string | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  agents.value = null;
  agentsError.value = null;
});

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the list, a
// failure included, since a route arrival reloads and a write can land
// while a load is in flight
let turn = 0;

export async function loadAgents(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  agentsError.value = null;
  try {
    const body = await api<AgentsResponse>("/api/agents");
    if (owner === forUser && turn === mine) agents.value = body.agents;
  } catch (err) {
    if (owner === forUser && turn === mine) agentsError.value = reason(err);
  }
}

export async function createAgent(
  body: SaveAgentRequest,
): Promise<AgentSummary> {
  const forUser = owner;
  const { agent } = await api<AgentResponse>("/api/agents", "POST", body);
  turn++;
  if (owner === forUser) agents.value = [...(agents.value ?? []), agent];
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
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const forUser = owner;
  await api(`/api/agents/${encodeURIComponent(id)}`, "DELETE");
  turn++;
  if (owner === forUser) {
    agents.value = (agents.value ?? []).filter((a) => a.id !== id);
  }
}
