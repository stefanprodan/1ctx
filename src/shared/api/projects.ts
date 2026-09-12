// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Response bodies of the project routes.

import type { ProjectDetail, ProjectSummary } from "../contracts/project.ts";

// GET /api/projects: the caller's projects, the personal one first
export type ProjectsResponse = { projects: ProjectSummary[] };

// GET /api/projects/:id
export type ProjectResponse = { project: ProjectDetail };
