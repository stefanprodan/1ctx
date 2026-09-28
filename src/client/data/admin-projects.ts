// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type { SendTotalsResponse } from "../../shared/api/admin.ts";
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
import { type Failure, failure } from "../lib/format.ts";
import { ApiError, api } from "./api.ts";
import { me } from "./me.ts";
import { loadProjects } from "./projects.ts";
import { usageSlot } from "./slot.ts";
import { onSocketEvent } from "./socket.ts";

export const adminProjects = signal<ProjectSummary[] | null>(null);
export const adminProjectsError = signal<Failure | null>(null);
export const adminProject = signal<ProjectDetail | null>(null);
export const adminProjectError = signal<Failure | null>(null);
export const projectUsage = usageSlot<SendTotalsResponse>(
  (id) => `/api/projects/${encodeURIComponent(id)}/usage`,
);
export const loadProjectUsage = projectUsage.load;

let owner: string | null = null;
let listTurn = 0;
let detailTurn = 0;
const seen = new Map<string, ProjectDetail>();

// users.ts hears every membership without this module importing it
type MembersListener = (projectId: string, memberIds: string[]) => void;
const membersListeners: MembersListener[] = [];
export function onProjectMembers(fn: MembersListener): void {
  membersListeners.push(fn);
}
const heard = (projectId: string, memberIds: string[]) => {
  for (const fn of membersListeners) fn(projectId, memberIds);
};

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
  seen.clear();
});

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
      adminProjectsError.value = failure(err);
    }
  }
}

export async function loadAdminProject(id: string): Promise<void> {
  const forUser = owner;
  const turn = ++detailTurn;
  adminProjectError.value = null;
  if (adminProject.value?.id !== id) adminProject.value = seen.get(id) ?? null;
  try {
    const body = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}`,
    );
    if (owner === forUser && detailTurn === turn) {
      adminProject.value = body.project;
      seen.set(id, body.project);
    }
  } catch (err) {
    if (owner === forUser && detailTurn === turn) {
      // deleted meanwhile, from another tab: it leaves the list too
      if (err instanceof ApiError && err.status === 404) drop(id);
      adminProjectError.value = failure(err);
    }
  }
}

function drop(id: string): void {
  listTurn++;
  seen.delete(id);
  if (adminProjects.value !== null) {
    adminProjects.value = adminProjects.value.filter((p) => p.id !== id);
  }
  if (adminProject.value?.id === id) adminProject.value = null;
}

function take(project: ProjectDetail, forUser: string | null): void {
  if (owner !== forUser) return;
  listTurn++;
  detailTurn++;
  seen.set(project.id, project);
  adminProject.value = project;
  adminProjectError.value = null;
  // a list never loaded stays unloaded: one row would pass for all
  if (adminProjects.value !== null) {
    adminProjects.value = [
      ...adminProjects.value.filter((p) => p.id !== project.id),
      summary(project),
    ].sort(byName);
  }
  heard(
    project.id,
    project.members.map((m) => m.id),
  );
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

export async function updateProject(
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

// a project another tab deleted is gone all the same
export async function deleteProject(id: string): Promise<number> {
  const forUser = owner;
  let deleted = 0;
  try {
    ({ deleted } = await api<DeleteProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}`,
      "DELETE",
    ));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  if (owner === forUser) {
    detailTurn++;
    drop(id);
    adminProjectError.value = null;
    heard(id, []);
  }
  void followRail(forUser);
  return deleted;
}

// a 409 on a membership already as asked is done: false says the
// detail is behind
const already = (err: unknown, words: string) =>
  err instanceof ApiError &&
  err.status === 409 &&
  err.message.toLowerCase().includes(words);

async function add(
  id: string,
  body: AddMemberRequest,
  forUser: string | null,
): Promise<boolean> {
  try {
    const { project } = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}/members`,
      "POST",
      body,
    );
    take(project, forUser);
    return true;
  } catch (err) {
    if (already(err, "already a member")) return false;
    throw err;
  }
}

async function remove(
  id: string,
  userId: string,
  forUser: string | null,
): Promise<boolean> {
  try {
    const { project } = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(
        userId,
      )}`,
      "DELETE",
    );
    take(project, forUser);
    return true;
  } catch (err) {
    if (already(err, "not a member")) return false;
    throw err;
  }
}

export async function addProjectMember(
  id: string,
  body: AddMemberRequest,
): Promise<void> {
  const forUser = owner;
  await add(id, body, forUser);
  await followRail(forUser);
}

export async function removeProjectMember(
  id: string,
  userId: string,
): Promise<void> {
  const forUser = owner;
  await remove(id, userId, forUser);
  await followRail(forUser);
}

// a refusal or an already-as-asked rereads: another tab's change, which
// no frame tells this one
export async function setProjectMembers(
  project: ProjectDetail,
  userIds: string[],
): Promise<void> {
  const forUser = owner;
  const had = project.members.map((m) => m.id);
  let failed: unknown = null;
  let behind = false;
  try {
    for (const userId of userIds) {
      if (!had.includes(userId)) {
        behind = !(await add(project.id, { userId }, forUser)) || behind;
      }
    }
    for (const userId of had) {
      if (!userIds.includes(userId)) {
        behind = !(await remove(project.id, userId, forUser)) || behind;
      }
    }
  } catch (err) {
    failed = err;
  }
  if ((failed !== null || behind) && owner === forUser) {
    await loadAdminProject(project.id);
  }
  await followRail(forUser);
  if (failed !== null) throw failed;
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
