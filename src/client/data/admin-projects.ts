// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin's team projects: the list its page opens, the detail of the
// row being edited, and the five writes. A write keeps the server's
// detail and reloads the shared project list so the rail follows it.

import { effect, signal } from "@preact/signals";
import type {
  AddMemberRequest,
  CreateProjectRequest,
  DeleteProjectResponse,
  ProjectResponse,
  ProjectsResponse,
  UpdateProjectRequest,
} from "../../shared/api/projects.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../shared/contracts/project.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { loadProjects } from "./projects.ts";
import { onSocketEvent } from "./socket.ts";

export const adminProjects = signal<ProjectSummary[] | null>(null);
export const adminProjectsError = signal<string | null>(null);
export const adminProject = signal<ProjectDetail | null>(null);
export const adminProjectError = signal<string | null>(null);

let owner: string | null = null;
let listTurn = 0;
let detailTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listTurn++;
  detailTurn++;
  adminProjects.value = null;
  adminProjectsError.value = null;
  adminProject.value = null;
  adminProjectError.value = null;
});

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const byName = (a: ProjectSummary, b: ProjectSummary) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const summary = (project: ProjectDetail): ProjectSummary => ({
  id: project.id,
  kind: project.kind,
  name: project.name,
  createdAt: project.createdAt,
  memberCount: project.members.length,
});

export async function loadAdminProjects(): Promise<void> {
  const forUser = owner;
  const turn = ++listTurn;
  adminProjectsError.value = null;
  try {
    const body = await api<ProjectsResponse>("/api/projects");
    if (owner === forUser && listTurn === turn) {
      adminProjects.value = body.projects.filter((p) => p.kind === "team");
    }
  } catch (err) {
    if (owner === forUser && listTurn === turn) {
      adminProjectsError.value = reason(err);
    }
  }
}

export async function loadAdminProject(id: string): Promise<void> {
  const forUser = owner;
  const turn = ++detailTurn;
  adminProjectError.value = null;
  if (adminProject.value !== null && adminProject.value.id !== id) {
    adminProject.value = null;
  }
  try {
    const body = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}`,
    );
    if (owner === forUser && detailTurn === turn) {
      adminProject.value = body.project;
    }
  } catch (err) {
    if (owner === forUser && detailTurn === turn) {
      adminProjectError.value = reason(err);
    }
  }
}

function take(project: ProjectDetail, forUser: string | null): void {
  if (owner !== forUser) return;
  listTurn++;
  detailTurn++;
  adminProject.value = project;
  adminProjectError.value = null;
  adminProjects.value = [
    ...(adminProjects.value ?? []).filter((p) => p.id !== project.id),
    summary(project),
  ].sort(byName);
}

async function followRail(forUser: string | null): Promise<void> {
  if (owner === forUser) await loadProjects();
}

export async function createProject(
  body: CreateProjectRequest,
): Promise<ProjectDetail> {
  const forUser = owner;
  const { project } = await api<ProjectResponse>("/api/projects", "POST", body);
  take(project, forUser);
  await followRail(forUser);
  return project;
}

export async function renameProject(
  id: string,
  body: UpdateProjectRequest,
): Promise<ProjectDetail> {
  const forUser = owner;
  const { project } = await api<ProjectResponse>(
    `/api/projects/${encodeURIComponent(id)}`,
    "PATCH",
    body,
  );
  take(project, forUser);
  await followRail(forUser);
  return project;
}

export async function deleteProject(id: string): Promise<number> {
  const forUser = owner;
  const { deleted } = await api<DeleteProjectResponse>(
    `/api/projects/${encodeURIComponent(id)}`,
    "DELETE",
  );
  if (owner === forUser) {
    listTurn++;
    detailTurn++;
    adminProjects.value = (adminProjects.value ?? []).filter(
      (p) => p.id !== id,
    );
    if (adminProject.value?.id === id) adminProject.value = null;
    adminProjectError.value = null;
  }
  await followRail(forUser);
  return deleted;
}

export async function addProjectMember(
  id: string,
  body: AddMemberRequest,
): Promise<ProjectDetail> {
  const forUser = owner;
  const { project } = await api<ProjectResponse>(
    `/api/projects/${encodeURIComponent(id)}/members`,
    "POST",
    body,
  );
  take(project, forUser);
  await followRail(forUser);
  return project;
}

export async function removeProjectMember(
  id: string,
  userId: string,
): Promise<ProjectDetail> {
  const forUser = owner;
  const { project } = await api<ProjectResponse>(
    `/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(
      userId,
    )}`,
    "DELETE",
  );
  take(project, forUser);
  await followRail(forUser);
  return project;
}

function onAccessChanged(event: SocketEvent): void {
  if (event.type !== "granted" && event.type !== "revoked") return;
  if (me.value?.role !== "admin") return;
  if (event.type === "revoked" && adminProject.value?.id === event.projectId) {
    detailTurn++;
    adminProject.value = null;
    adminProjectError.value = null;
  }
  void loadAdminProjects();
}

onSocketEvent(onAccessChanged);
