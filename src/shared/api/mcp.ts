// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the MCP routes: the admin's, and a
// project's list of its servers.

import type { McpScope, McpServerSummary, McpSide } from "../contracts/mcp.ts";
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

// the grants: the team projects, and the most a personal project gets
export type McpGrants = { projects?: McpProjects; personal?: McpSide };

// POST /api/mcp: discovers, then inserts the row and its tools.
// projects and personal are required with a key; without one they
// default to all and read; a key with an empty list is refused
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
} & McpGrants;

// PATCH /api/mcp/:id: the settings, any of them, or the endpoint
// (url and/or keyName), which discovers first; the grants go with
// either and replace what is held, else they stay
export type PatchMcpSettings = Partial<{
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
}> &
  McpGrants;
export type PatchMcpEndpoint = Partial<{
  url: string;
  keyName: string | null;
}> &
  McpGrants;
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

// a server granted to a project: its tool count by its own switches and
// patterns, and whether every team project has it or this one is
// listed; on a personal project always all, since the personal grant is
// every personal project's, a list server's included. choice is the project's, read
// when it made none; ceiling the most it may choose; side what a send
// is given (offeredSide()). read is the server's Read switch, so a page
// hides Read when it is off. Never its URL or key file. projects is an
// admin's, on a team list row: how many projects the list holds, so
// removing the last one asks first
export type ProjectMcpServer = {
  id: string;
  name: string;
  tools: number;
  scope: McpScope;
  choice: McpSide;
  ceiling: McpSide;
  side: McpSide;
  read: boolean;
  projects?: number;
};

// GET /api/projects/:id/mcp, in name order, and the answer of its
// POST, DELETE and the side PUTs. addable is an admin's on a team
// project: the servers with a list that does not hold the project, an
// empty one included; empty for anyone else
export type ProjectMcpResponse = {
  servers: ProjectMcpServer[];
  addable: { id: string; name: string }[];
};

// POST /api/projects/:id/mcp: lists the project on the server
export type AddProjectMcpRequest = { serverId: string };

// PUT /api/projects/:id/mcp/:serverId/side (an admin, a team project)
// and PUT /api/profile/project/mcp/:serverId/side (the owner): the
// project's choice; a server not granted is a 404, a side above the
// ceiling a 400
export type ProjectMcpSideRequest = { side: McpSide };
