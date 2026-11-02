// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the MCP routes: the admin's, and a
// project's list of its servers.

import type { McpScope, McpServerSummary } from "../contracts/mcp.ts";
import type { Windowed } from "./admin.ts";

// GET /api/mcp: the rows, the names of the mcp- key files the form may
// pick (names alone, never a value), the limits' call timeout a server
// without its own runs under, so the form's hint can name it, and when
// they were read, so a page can say how old its preview is
export type McpResponse = {
  servers: McpServerSummary[];
  keys: string[];
  callTimeoutMs: number;
  loadedAt: number;
};

// POST /api/mcp, PATCH /api/mcp/:id and POST /api/mcp/:id/refresh
export type McpServerResponse = { server: McpServerSummary };

// where a server is offered: "all", or the team project ids it lists
export type McpProjects = "all" | string[];

// POST /api/mcp: discovers, then inserts the row and its tools.
// projects is required with a key and defaults to all without one; a
// key with an empty list is refused
export type CreateMcpRequest = {
  name: string;
  url: string;
  keyName: string | null;
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
  projects?: McpProjects;
};

// PATCH /api/mcp/:id: the settings, any of them, or the endpoint
// (url and/or keyName), which discovers first; projects goes with
// either and replaces the held scope, else the scope stays
export type PatchMcpSettings = Partial<{
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
  projects: McpProjects;
}>;
export type PatchMcpEndpoint = Partial<{
  url: string;
  keyName: string | null;
  projects: McpProjects;
}>;
export type PatchMcpRequest = PatchMcpSettings | PatchMcpEndpoint;

export type McpCalls = { calls: number; failed: number };
// the most called first
export type McpUsage = McpCalls & { tools: { name: string; calls: number }[] };
// the most called first, a deleted server's calls under its name
export type McpServersUsage = McpCalls & {
  servers: ({ name: string } & McpCalls)[];
};

// GET /api/mcp/:id/usage and /api/mcp/usage: the last 30 days
export type McpUsageResponse = Windowed<McpUsage>;
export type McpUsageAllResponse = Windowed<McpServersUsage>;

// a server offered in a project: its tool count by its own switches and
// patterns, and whether every project has it or this one is listed.
// Never its URL or key file
export type ProjectMcpServer = {
  id: string;
  name: string;
  tools: number;
  scope: McpScope;
};

// GET /api/projects/:id/mcp, in name order, and the answer of its
// POST. addable is an admin's on a team project: the servers with a
// list that does not hold the project, an empty one included; empty
// for anyone else
export type ProjectMcpResponse = {
  servers: ProjectMcpServer[];
  addable: { id: string; name: string }[];
};

// POST /api/projects/:id/mcp: lists the project on the server
export type AddProjectMcpRequest = { serverId: string };
