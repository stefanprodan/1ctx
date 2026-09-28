// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectResponse } from "../../src/shared/api/projects.ts";
import type { ProjectDetail } from "../../src/shared/contracts/project.ts";
import type { TestClient } from "./app.ts";

export async function createTeam(
  client: TestClient,
  name: string,
  members: string[] = [],
): Promise<ProjectDetail> {
  let response = await client.call("POST", "/api/projects", {
    body: { name, description: "A team project." },
  });
  if (response.status !== 201) {
    throw new Error(
      `project create answered ${response.status}: ${await response.text()}`,
    );
  }
  let { project }: ProjectResponse = await response.json();
  for (const userId of members) {
    response = await client.call(
      "POST",
      `/api/projects/${project.id}/members`,
      {
        body: { userId },
      },
    );
    if (response.status !== 201) {
      throw new Error(
        `project member add answered ${response.status}: ${await response.text()}`,
      );
    }
    ({ project } = (await response.json()) as ProjectResponse);
  }
  return project;
}
