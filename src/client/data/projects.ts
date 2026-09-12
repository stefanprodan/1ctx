// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's projects: the list the rail and the Projects page read,
// loaded with the shell and again on the Projects page, and the one
// project a page shows.
// Every answer is kept only when it is still the one wanted: for the
// signed-in user of the moment, for the project on screen, and from
// the latest request, a failure included. Both are dropped with the
// signed-in user, so nothing of one user's shows to the next.

import { effect, signal } from "@preact/signals";
import type {
  ProjectResponse,
  ProjectsResponse,
} from "../../shared/api/projects.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../shared/contracts/project.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const projects = signal<ProjectSummary[] | null>(null);
export const projectsError = signal<string | null>(null);
export const project = signal<ProjectDetail | null>(null);
export const projectError = signal<string | null>(null);

let owner: string | null = null;
let listing: Promise<void> | null = null;
let marks: object = {};
let wanted: { id: string; turn: number } = { id: "", turn: 0 };

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  listing = null;
  wanted = { id: "", turn: wanted.turn + 1 };
  projects.value = null;
  projectsError.value = null;
  project.value = null;
  projectError.value = null;
});

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// one request at a time: the rail and the page asking together share it
export function loadProjects(): Promise<void> {
  if (listing !== null) return listing;
  const forUser = owner;
  projectsError.value = null;
  // this request's mark: a later user change replaces the shared
  // promise, and only the request that still holds it clears it
  const mark = {};
  marks = mark;
  const run = (async () => {
    try {
      const body = await api<ProjectsResponse>("/api/projects");
      if (owner === forUser) projects.value = body.projects;
    } catch (err) {
      if (owner === forUser) projectsError.value = reason(err);
    } finally {
      if (marks === mark) listing = null;
    }
  })();
  listing = run;
  return run;
}

export async function loadProject(id: string): Promise<void> {
  const turn = wanted.turn + 1;
  wanted = { id, turn };
  projectError.value = null;
  if (project.value !== null && project.value.id !== id) project.value = null;
  try {
    const body = await api<ProjectResponse>(
      `/api/projects/${encodeURIComponent(id)}`,
    );
    if (wanted.turn === turn) project.value = body.project;
  } catch (err) {
    if (wanted.turn === turn) projectError.value = reason(err);
  }
}
