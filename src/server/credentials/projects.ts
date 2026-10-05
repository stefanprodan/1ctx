// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type ProjectsPort = {
  byId(id: string): { kind: string; name: string } | null;
};

// a team project's name, null for a personal or a missing one
export function teamName(projects: ProjectsPort, id: string): string | null {
  const project = projects.byId(id);
  return project?.kind === "team" ? project.name : null;
}
