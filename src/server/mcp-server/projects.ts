// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectsInput } from "./parse.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";
import { cappedLines, jsonLine, type McpResult, textResult } from "./result.ts";

export function projectsTool(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  input: ProjectsInput,
): McpResult {
  const projects = deps.access
    .reachableProjectIds(principal)
    .flatMap((id) => {
      const project = deps.projects.byId(id);
      return project === null ? [] : [project];
    })
    .filter((project) => input.after === null || project.id > input.after)
    .sort((left, right) => left.id.localeCompare(right.id));
  return textResult(
    cappedLines(
      projects.map((project) =>
        jsonLine({
          id: project.id,
          name: project.name,
          kind: project.kind,
        }),
      ),
      (next) =>
        `Read on with projects action=list, after=${projects[next - 1]!.id}.`,
    ),
  );
}
