// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Response bodies of the project routes.

import type { ProjectDetail, ProjectSummary } from "../contracts/project.ts";

// GET /api/projects: the caller's projects, the personal one first
export type ProjectsResponse = { projects: ProjectSummary[] };

// GET /api/projects/:id and every project write
export type ProjectResponse = { project: ProjectDetail };

export type CreateProjectRequest = { name: string; description: string };
// at least one of the two
export type UpdateProjectRequest = { name?: string; description?: string };
// PATCH /api/profile/project: the name is always personal
export type UpdatePersonalProjectRequest = { description: string };
export type AddMemberRequest = { userId: string };
export type DeleteProjectResponse = { deleted: number };
// GET /api/projects/:id/usage (admin, a team project): the last 30 days
// of every agent's turns and runs in it
export type ProjectUsageResponse = {
  since: number;
  until: number;
  sends: number;
  tokens: number;
  cost: number | null;
};
