// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the MCP routes, all for admins.

import type { McpServerSummary } from "../contracts/mcp.ts";

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

// POST /api/mcp: discovers, then inserts the row and its tools
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
};

// PATCH /api/mcp/:id: the settings, any of them, or the endpoint
// (url and/or keyName and nothing else), which discovers first
export type PatchMcpSettings = Partial<{
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
}>;
export type PatchMcpEndpoint = Partial<{ url: string; keyName: string | null }>;
export type PatchMcpRequest = PatchMcpSettings | PatchMcpEndpoint;
