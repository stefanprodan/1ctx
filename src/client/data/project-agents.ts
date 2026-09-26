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
import type { PickAgentRequest } from "../../shared/api/agents.ts";
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
// the agent a new chat starts on for this user: the one they last
// picked, else the default, as the server resolved it with the agents
export const startsOn = signal<string | null>(null);
// bumped by a pick and again when its write settles, so an agents
// answer the server may have made before it had the pick never puts
// the old start back
let pickTurn = 0;
let writing = 0;
// a pick the server did not take stays this tab's start until the next
let unsaved = false;
// the project Home's composer starts a chat in, as the user picked it
// for the life of the tab; null for the personal project
export const homeProjectId = signal<string | null>(null);

let owner: string | null = null;
let turn = 0;
// the turn whose answer is shown: a newer one for the project on screen
// is kept even while a later request is out
let shownTurn = 0;
let shownFor: string | null = null;
const kept = new Held<ProjectAgentsResponse>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  shownTurn = turn;
  projectAgents.value = null;
  startsOn.value = null;
  writing = 0;
  unsaved = false;
  shownFor = null;
  kept.clear();
  homeProjectId.value = null;
});

// the agent a new chat or task starts on: the last pick while it is in
// the list, else the default, else the first
export function startingAgent(list: AgentSummary[]): string | null {
  const start = startsOn.value;
  if (list.some((a) => a.id === start)) return start;
  return (list.find((a) => a.default) ?? list[0])?.id ?? null;
}

// the composer's pick is the user's next start, in this tab at once and
// on the server for the next; a failed write costs only the latter
export async function rememberAgent(agentId: string): Promise<void> {
  const forUser = owner;
  pickTurn++;
  writing++;
  startsOn.value = agentId;
  const body: PickAgentRequest = { agentId };
  let saved = true;
  try {
    await api("/api/profile/agent", "PUT", body);
  } catch {
    saved = false;
  }
  if (owner !== forUser) return;
  // a sign-out and back while it was out already set it to 0
  writing = Math.max(0, writing - 1);
  pickTurn++;
  unsaved = !saved;
}

export function projectAgentCount(projectId: string): number | null {
  const list = projectAgents.value;
  return list === null || shownFor !== projectId ? null : list.length;
}

export async function loadProjectAgents(projectId: string): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const picks = pickTurn;
  if (shownFor !== projectId) {
    // the pick is the user's, not the project's, so a held answer never
    // brings back one picked over since
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
    if (owner !== forUser || shownFor !== projectId || mine <= shownTurn) {
      return;
    }
    shownTurn = mine;
    kept.set(projectId, body);
    projectAgents.value = body.agents;
    if (picks === pickTurn && writing === 0 && !unsaved) {
      startsOn.value = body.startsOn;
    }
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
