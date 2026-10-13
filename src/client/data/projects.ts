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
  CreateLabelRequest,
  ProjectResponse,
  ProjectsResponse,
  UpdateAboutRequest,
  UpdateLabelRequest,
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
// per project, the last metadata write sent and the newest one whose
// answer landed: an older answer landing late would put back what a
// newer one changed, and a newer write that fails leaves the older one
const sent = new Map<string, number>();
const landed = new Map<string, number>();

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
  sent.clear();
  landed.clear();
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

// admin-projects.ts hears a metadata write without this module
// importing it, so the admin page shows the same row
type SavedListener = (saved: ProjectDetail) => void;
const savedListeners: SavedListener[] = [];
export function onProjectSaved(fn: SavedListener): void {
  savedListeners.push(fn);
}

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

// a metadata write from the Settings tab, by any user who sees the
// project; its answer is the detail, kept as an admin write's is
async function writeMetadata(
  id: string,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<void> {
  const forUser = owner;
  const mine = (sent.get(id) ?? 0) + 1;
  sent.set(id, mine);
  const { project: saved } = await api<ProjectResponse>(path, method, body);
  if (owner !== forUser || (landed.get(id) ?? 0) > mine) return;
  landed.set(id, mine);
  keepProject(saved);
  for (const fn of savedListeners) fn(saved);
}

export const saveAbout = (id: string, body: UpdateAboutRequest) =>
  writeMetadata(id, `${projectPath(id)}/about`, "PATCH", body);

export const addLabel = (id: string, body: CreateLabelRequest) =>
  writeMetadata(id, `${projectPath(id)}/labels`, "POST", body);

export const changeLabel = (
  id: string,
  labelId: string,
  body: UpdateLabelRequest,
) =>
  writeMetadata(
    id,
    `${projectPath(id)}/labels/${encodeURIComponent(labelId)}`,
    "PATCH",
    body,
  );

export const deleteLabel = (id: string, labelId: string) =>
  writeMetadata(
    id,
    `${projectPath(id)}/labels/${encodeURIComponent(labelId)}`,
    "DELETE",
  );

// a write's answer, the admin's on a team project included, lands over
// any load out, so the project's tabs and the admin page show one row
export function keepProject(saved: ProjectDetail): void {
  kept.set(saved.id, saved);
  if (project.value?.id === saved.id) {
    wanted = { id: saved.id, turn: wanted.turn + 1 };
    project.value = saved;
    projectError.value = null;
  }
}

function onAccessChanged(event: SocketEvent): void {
  if (event.type === "revoked") kept.delete(event.projectId);
  if (event.type === "granted" || event.type === "revoked") {
    void loadProjects();
  }
}

onSocketEvent(onAccessChanged);
