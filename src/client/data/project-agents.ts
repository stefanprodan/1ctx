// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents of the project on screen, as its composer and its pages
// list them, with what their answer says can be switched; and the
// project Home's composer starts a chat in. The answers of the projects
// seen before are held, so going back to one draws its agents at once
// while they load again. A held answer is that project's own, so a send
// never pairs an agent with a project it is not in.

import { effect, signal } from "@preact/signals";
import type { ProjectAgentsResponse } from "../../shared/api/sessions.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { api } from "./api.ts";
import { answered } from "./capabilities.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";
import { loadUploads } from "./uploads.ts";

export const projectAgents = signal<AgentSummary[] | null>(null);
// the project Home's composer starts a chat in, as the user picked it
// for the life of the tab; null for the personal project
export const homeProjectId = signal<string | null>(null);

let owner: string | null = null;
let turn = 0;
let shownFor: string | null = null;
const kept = new Held<ProjectAgentsResponse>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  projectAgents.value = null;
  shownFor = null;
  kept.clear();
  homeProjectId.value = null;
});

export function projectAgentCount(projectId: string): number | null {
  const list = projectAgents.value;
  return list === null || shownFor !== projectId ? null : list.length;
}

export async function loadProjectAgents(projectId: string): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  if (shownFor !== projectId) {
    const held = kept.get(projectId);
    projectAgents.value = held?.agents ?? null;
    if (held !== undefined) answered(held);
  }
  shownFor = projectId;
  const current = () => owner === forUser && mine === turn;
  try {
    const body = await api<ProjectAgentsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/agents`,
    );
    if (!current()) return;
    kept.set(projectId, body);
    projectAgents.value = body.agents;
    answered(body);
  } catch {
    if (current()) projectAgents.value = null;
  }
}

// Home's composer moves to another project: its agents replace the
// last project's, the held ones or none until they answer
export async function pickHomeProject(projectId: string): Promise<void> {
  homeProjectId.value = projectId;
  await Promise.all([loadProjectAgents(projectId), loadUploads(projectId)]);
}

function onRevoked(ev: SocketEvent): void {
  if (ev.type === "revoked") kept.delete(ev.projectId);
}

onSocketEvent(onRevoked);
