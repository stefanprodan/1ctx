// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers, as its Settings tab and its admin page list
// them, by project id. An admin's add and remove and a choice of a
// server's side answer the whole list, and change what the project's
// agents are offered, so the project's agents are read again.

import { effect, signal } from "@preact/signals";
import type {
  AddProjectMcpRequest,
  ProjectMcpResponse,
  ProjectMcpSideRequest,
} from "../../shared/api/mcp.ts";
import type { McpSide } from "../../shared/contracts/mcp.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { reloadProjectAgents } from "./project-agents.ts";

export const projectMcpLists = signal<ReadonlyMap<string, ProjectMcpResponse>>(
  new Map(),
);
export const projectMcpErrors = signal<ReadonlyMap<string, Failure>>(new Map());

let owner: string | null = null;
const turns = new Map<string, number>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turns.clear();
  projectMcpLists.value = new Map();
  projectMcpErrors.value = new Map();
});

export const projectMcpOf = (projectId: string): ProjectMcpResponse | null =>
  projectMcpLists.value.get(projectId) ?? null;

export const projectMcpErrorOf = (projectId: string): Failure | null =>
  projectMcpErrors.value.get(projectId) ?? null;

const listUrl = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/mcp`;

const turnOf = (projectId: string) => {
  const next = (turns.get(projectId) ?? 0) + 1;
  turns.set(projectId, next);
  return next;
};

function setList(projectId: string, list: ProjectMcpResponse | null): void {
  if (list === null && !projectMcpLists.value.has(projectId)) return;
  const next = new Map(projectMcpLists.value);
  if (list === null) next.delete(projectId);
  else next.set(projectId, list);
  projectMcpLists.value = next;
}

function setError(projectId: string, error: Failure | null): void {
  if (error === null && !projectMcpErrors.value.has(projectId)) return;
  const next = new Map(projectMcpErrors.value);
  if (error === null) next.delete(projectId);
  else next.set(projectId, error);
  projectMcpErrors.value = next;
}

export async function loadProjectMcp(projectId: string): Promise<void> {
  const forUser = owner;
  const mine = turnOf(projectId);
  try {
    const body = await api<ProjectMcpResponse>(listUrl(projectId));
    if (owner !== forUser || turns.get(projectId) !== mine) return;
    setList(projectId, body);
    setError(projectId, null);
  } catch (err) {
    if (owner !== forUser || turns.get(projectId) !== mine) return;
    const failed = failure(err);
    // rows the server no longer answers for are never left to act on
    if (failed.status === 403 || failed.status === 404) {
      setList(projectId, null);
    }
    setError(projectId, failed);
  }
}

// a write's answer is the whole list and lands over any load out
function keep(
  projectId: string,
  body: ProjectMcpResponse,
  forUser: string | null,
) {
  if (owner !== forUser) return;
  turnOf(projectId);
  setList(projectId, body);
  setError(projectId, null);
  reloadProjectAgents(projectId);
}

export async function addProjectMcp(
  projectId: string,
  serverId: string,
): Promise<void> {
  const forUser = owner;
  const body: AddProjectMcpRequest = { serverId };
  try {
    const answer = await api<ProjectMcpResponse>(
      listUrl(projectId),
      "POST",
      body,
    );
    keep(projectId, answer, forUser);
  } catch (err) {
    // a server another tab added, widened or deleted: the list, and its
    // addable, read again
    await loadProjectMcp(projectId);
    throw err;
  }
}

export async function removeProjectMcp(
  projectId: string,
  serverId: string,
): Promise<void> {
  const forUser = owner;
  try {
    const answer = await api<ProjectMcpResponse>(
      `${listUrl(projectId)}/${encodeURIComponent(serverId)}`,
      "DELETE",
    );
    keep(projectId, answer, forUser);
  } catch (err) {
    // another tab took it out, or widened it to every project: the list
    // reads again either way
    await loadProjectMcp(projectId);
    throw err;
  }
}

// the project's choice of a server's side: an admin's on a team
// project, the owner's on their personal one, which has its own route
export async function setProjectMcpSide(
  projectId: string,
  serverId: string,
  side: McpSide,
  personal: boolean,
): Promise<void> {
  const forUser = owner;
  const body: ProjectMcpSideRequest = { side };
  const server = encodeURIComponent(serverId);
  try {
    const answer = await api<ProjectMcpResponse>(
      personal
        ? `/api/profile/project/mcp/${server}/side`
        : `${listUrl(projectId)}/${server}/side`,
      "PUT",
      body,
    );
    keep(projectId, answer, forUser);
  } catch (err) {
    // a grant lowered or taken away meanwhile: the list reads again
    await loadProjectMcp(projectId);
    throw err;
  }
}
