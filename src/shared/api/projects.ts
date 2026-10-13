// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the project routes.

import type { LabelInput } from "../contracts/label.ts";
import type { ProjectDetail, ProjectSummary } from "../contracts/project.ts";

// GET /api/projects: the caller's projects, the personal one first
export type ProjectsResponse = { projects: ProjectSummary[] };

// GET /api/projects/:id and every project write
export type ProjectResponse = { project: ProjectDetail };

// labels left out start the project with DEFAULT_LABELS
export type CreateProjectRequest = {
  name: string;
  description: string;
  labels?: LabelInput[];
};
// at least one of the two
export type UpdateProjectRequest = { name?: string; description?: string };
// PATCH /api/projects/:id/about: any user who sees the project
export type UpdateAboutRequest = { description: string };
// POST /api/projects/:id/labels
export type CreateLabelRequest = LabelInput;
// PATCH /api/projects/:id/labels/:labelId: at least one of the two
export type UpdateLabelRequest = { name?: string; description?: string };
export type AddMemberRequest = { userId: string };
export type DeleteProjectResponse = { deleted: number };
