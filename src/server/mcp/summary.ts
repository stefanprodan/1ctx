// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server row as the admin's page reads it.

import type {
  McpOn,
  McpProject,
  McpServerSummary,
  McpSide,
  McpToolSummary,
} from "../../shared/contracts/mcp.ts";
import { wireName } from "../../shared/mcp.ts";
import type { McpServerRow } from "./store.ts";

function codeFence(json: string): string {
  const longest = Math.max(
    0,
    ...Array.from(json.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

// the listed team projects by name; an id whose project is gone or not
// a team one is left out
export function projectsOf(
  server: Pick<McpServerRow, "projectIds">,
  teamName: (id: string) => string | null,
): McpProject[] {
  return server.projectIds
    .flatMap((id) => {
      const name = teamName(id);
      return name === null ? [] : [{ id, name }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// where.teams by name, a project gone since left out
export function onOf(
  where: { teams: Map<string, McpSide>; personal: number } | undefined,
  teamName: (id: string) => string | null,
): McpOn {
  return {
    projects: projectsOf(
      { projectIds: [...(where?.teams.keys() ?? [])] },
      teamName,
    ),
    personal: where?.personal ?? 0,
  };
}

export function summary(
  server: McpServerRow,
  hasSecret: (name: string) => boolean,
  render: (markdown: string) => string,
  teamName: (id: string) => string | null,
  where?: { teams: Map<string, McpSide>; personal: number },
): McpServerSummary {
  const tools: McpToolSummary[] = server.tools.map((tool) => {
    const name = wireName(server.name, tool.name);
    let value: unknown = {};
    try {
      value = JSON.parse(tool.inputSchema);
    } catch {
      value = {};
    }
    const json = JSON.stringify(value, null, 2);
    return {
      name: tool.name,
      wireName: name,
      unusable: tool.unusable ?? (name === null ? "unusable name" : null),
      description: tool.description,
      parameters: value as object,
      schemaJson: tool.inputSchema,
      parametersHtml: render(codeFence(json)),
    };
  });
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    keyName: server.keyName,
    hasKey: server.keyName !== null && hasSecret(server.keyName),
    read: server.read,
    write: server.write,
    instructionsOn: server.instructionsOn,
    timeoutMs: server.timeoutMs,
    readPatterns: server.readPatterns,
    writePatterns: server.writePatterns,
    excludedPatterns: server.excludedPatterns,
    scope: server.scope,
    projects: projectsOf(server, teamName),
    personal: server.personal,
    on: onOf(where, teamName),
    serverName: server.serverName,
    serverVersion: server.serverVersion,
    protocolVersion: server.protocolVersion,
    instructions: server.instructions,
    checkedAt: server.checkedAt,
    lastChange: server.lastChange,
    refreshError: server.refreshError,
    refreshFailedAt: server.refreshFailedAt,
    createdAt: server.createdAt,
    tools,
  };
}
