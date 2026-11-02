// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An McpServer document: its offline checks and its apply through the
// MCP routes. Its projects are all or team project names, its choices
// team projects' sides, applied after the server and its grants.

import type {
  McpResponse,
  PatchMcpEndpoint,
  PatchMcpSettings,
  ProjectMcpResponse,
} from "../../shared/api/mcp.ts";
import type { ProjectsResponse } from "../../shared/api/projects.ts";
import { PERSONAL_PROJECT_NAME } from "../../shared/words.ts";
import { type Action, type Client, difference, idOf } from "./client.ts";
import type { McpServerSpec } from "./spec.ts";

// a name another document or the instance must hold
type Reference = (field: string, kind: "Project", name: string) => void;

// offline, before anything is written: a key acting for one owner
// reaches no one by accident, and a list names team projects alone
export function checkMcpServer(
  spec: McpServerSpec,
  exists: boolean,
  fail: (field: string, message: string) => never,
  reference: Reference,
): void {
  const { keyFrom, projects } = spec;
  if (keyFrom && !exists && projects === undefined) {
    fail("projects", "is required for a new server with a key");
  }
  if (keyFrom && !exists && spec.personal === undefined) {
    fail("personal", "is required for a new server with a key");
  }
  for (const choice of spec.choices ?? []) {
    if (choice.project === PERSONAL_PROJECT_NAME) {
      fail("choices", "cannot name a personal project");
    }
    reference("choices", "Project", choice.project);
  }
  if (keyFrom && Array.isArray(projects) && projects.length === 0) {
    fail("projects", "must be all or name a project with a key");
  }
  if (projects !== "all") teamNames(projects ?? [], fail, reference);
}

// a Credential's list and a server's: team projects the instance holds
// or the documents make
export function teamNames(
  names: string[],
  fail: (field: string, message: string) => never,
  reference: Reference,
): void {
  for (const name of names) {
    if (name === PERSONAL_PROJECT_NAME) {
      fail("projects", "cannot name a personal project");
    }
    reference("projects", "Project", name);
  }
}

export async function applyMcpServer(
  api: Client,
  doc: { name: string; spec: McpServerSpec },
): Promise<Action> {
  const { servers } = await api.call<McpResponse>("GET", "/api/mcp");
  const before = servers.find((row) => row.name === doc.name);
  const { url, keyFrom, projects: named, choices, ...rest } = doc.spec;
  let projects: "all" | string[] | undefined =
    named === "all" ? "all" : undefined;
  const teams = async () =>
    (await api.call<ProjectsResponse>("GET", "/api/projects")).projects.filter(
      (row) => row.kind === "team",
    );
  if (Array.isArray(named)) {
    const found = await teams();
    projects = named.map((name) => idOf(found, name));
  }
  const chose = async (): Promise<boolean> => {
    if (choices === undefined || choices.length === 0) return false;
    const found = await teams();
    const { servers: after } = await api.call<McpResponse>("GET", "/api/mcp");
    const serverId = idOf(after, doc.name);
    let moved = false;
    for (const { project, side } of choices) {
      const projectId = idOf(found, project);
      const list = await api.call<ProjectMcpResponse>(
        "GET",
        `/api/projects/${projectId}/mcp`,
      );
      const held = list.servers.find((row) => row.id === serverId);
      if (held?.choice === side) continue;
      await api.call("PUT", `/api/projects/${projectId}/mcp/${serverId}/side`, {
        side,
      });
      moved = true;
    }
    return moved;
  };
  // left out, an update keeps the scope and a create takes the API's
  const settings = { ...rest, ...(projects === undefined ? {} : { projects }) };
  const endpoint = {
    ...(url === undefined ? {} : { url }),
    ...(keyFrom === undefined ? {} : { keyName: keyFrom }),
  };
  if (!before) {
    await api.call("POST", "/api/mcp", {
      name: doc.name,
      url,
      keyName: keyFrom ?? null,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: [],
      writePatterns: [],
      excludedPatterns: [],
      ...settings,
    });
    await chose();
    return "created";
  }
  const endpointPatch: PatchMcpEndpoint = difference(before, endpoint);
  const settingsPatch: PatchMcpSettings = difference(
    {
      ...before,
      projects:
        before.scope === "all" ? "all" : before.projects.map((row) => row.id),
    },
    settings,
  );
  const changedEndpoint = Object.keys(endpointPatch).length > 0;
  // the grants go with a new endpoint, so a key added never reaches
  // everyone between two writes
  if (changedEndpoint && projects !== undefined) {
    endpointPatch.projects = projects;
    delete settingsPatch.projects;
  }
  if (changedEndpoint && settings.personal !== undefined) {
    endpointPatch.personal = settings.personal;
    delete settingsPatch.personal;
  }
  const changedSettings = Object.keys(settingsPatch).length > 0;
  if (changedEndpoint) {
    await api.call("PATCH", `/api/mcp/${before.id}`, endpointPatch);
  }
  if (changedSettings) {
    await api.call("PATCH", `/api/mcp/${before.id}`, settingsPatch);
  }
  const changedChoices = await chose();
  return changedEndpoint || changedSettings || changedChoices
    ? "updated"
    : "unchanged";
}
