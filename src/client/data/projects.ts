// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's projects: the list the rail and the Projects page read,
// loaded with the shell and again on the Projects page, and the one
// project a page shows.
// Every answer is kept only when it is still the one wanted: for the
// signed-in user of the moment, for the project on screen, and from
// the latest request, a failure included. Both are dropped with the
// signed-in user, so nothing of one user's shows to the next. A project
// seen before is held, so its page draws at once while it loads again.

import { effect, signal } from "@preact/signals";
import type {
  ProjectResponse,
  ProjectsResponse,
  UpdatePersonalProjectRequest,
} from "../../shared/api/projects.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../shared/contracts/project.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { Held } from "./held.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

export const projects = signal<ProjectSummary[] | null>(null);
export const projectsError = signal<Failure | null>(null);
export const project = signal<ProjectDetail | null>(null);
export const projectError = signal<Failure | null>(null);

let owner: string | null = null;
let listTurn = 0;
// the turn whose list is shown: an answer newer than it is kept even
// when a later request is still out, so the shell's load and a route's
// own, started together, draw the list at the first answer
let listShown = 0;
let wanted: { id: string; turn: number } = { id: "", turn: 0 };
const kept = new Held<ProjectDetail>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listTurn++;
  listShown = listTurn;
  wanted = { id: "", turn: wanted.turn + 1 };
  projects.value = null;
  projectsError.value = null;
  project.value = null;
  projectError.value = null;
  kept.clear();
});

export async function loadProjects(): Promise<void> {
  const forUser = owner;
  const turn = ++listTurn;
  projectsError.value = null;
  try {
    const body = await api<ProjectsResponse>("/api/projects");
    if (owner === forUser && turn > listShown) {
      listShown = turn;
      projects.value = body.projects;
    }
  } catch (err) {
    if (owner === forUser && listTurn === turn) {
      projectsError.value = failure(err);
    }
  }
}

export async function loadProject(id: string): Promise<void> {
  const turn = wanted.turn + 1;
  wanted = { id, turn };
  projectError.value = null;
  if (project.value?.id !== id) project.value = kept.get(id) ?? null;
  try {
    const body = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}`,
    );
    if (wanted.turn !== turn) return;
    kept.set(id, body.project);
    project.value = body.project;
  } catch (err) {
    if (wanted.turn !== turn) return;
    // a held copy of a project no longer seen goes with it
    kept.delete(id);
    if (project.value?.id === id) project.value = null;
    projectError.value = failure(err);
  }
}

// the caller's personal project; the page keeps the answer when it
// still shows that project, and the rail follows the name
export async function savePersonalProject(
  body: UpdatePersonalProjectRequest,
): Promise<void> {
  const forUser = owner;
  const { project: saved } = await api<ProjectResponse>(
    "/api/profile/project",
    "PATCH",
    body,
  );
  if (owner !== forUser) return;
  kept.set(saved.id, saved);
  if (project.value?.id === saved.id) {
    wanted = { id: saved.id, turn: wanted.turn + 1 };
    project.value = saved;
    projectError.value = null;
  }
  await loadProjects();
}

function onAccessChanged(event: SocketEvent): void {
  if (event.type === "revoked") kept.delete(event.projectId);
  if (event.type === "granted" || event.type === "revoked") {
    void loadProjects();
  }
}

onSocketEvent(onAccessChanged);
