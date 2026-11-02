// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An McpServer document: its offline checks and its apply through the
// MCP routes. Its projects are all or team project names.

import type { McpResponse, PatchMcpSettings } from "../../shared/api/mcp.ts";
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
  const { url, keyFrom, projects: named, ...rest } = doc.spec;
  let projects: "all" | string[] | undefined =
    named === "all" ? "all" : undefined;
  if (Array.isArray(named)) {
    const found = await api.call<ProjectsResponse>("GET", "/api/projects");
    const teams = found.projects.filter((row) => row.kind === "team");
    projects = named.map((name) => idOf(teams, name));
  }
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
    return "created";
  }
  const endpointPatch = difference(before, endpoint);
  const settingsPatch: PatchMcpSettings = difference(
    {
      ...before,
      projects:
        before.scope === "all" ? "all" : before.projects.map((row) => row.id),
    },
    settings,
  );
  const changedEndpoint = Object.keys(endpointPatch).length > 0;
  const changedSettings = Object.keys(settingsPatch).length > 0;
  if (changedEndpoint) {
    await api.call("PATCH", `/api/mcp/${before.id}`, endpointPatch);
  }
  if (changedSettings) {
    await api.call("PATCH", `/api/mcp/${before.id}`, settingsPatch);
  }
  return changedEndpoint || changedSettings ? "updated" : "unchanged";
}
