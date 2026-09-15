// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server as the wire exposes it: the row an admin registered,
// what discovery found on it, and the tools it listed. A tool's side
// is never stored: the page and the policy compute it from the
// patterns through shared/mcp.ts.

// what a refresh found different, with tool names
export type McpChange = {
  at: number;
  added: string[];
  removed: string[];
  // a description or an input schema moved
  changed: string[];
  instructions: boolean;
};

export type McpToolSummary = {
  name: string;
  // null when the composed wire name breaks the OpenAI rule
  wireName: string | null;
  // the reason discovery stored, or null
  unusable: string | null;
  // as the server sent it, cut at the discovery cap
  description: string;
  // the stored input schema as JSON
  schemaJson: string;
  // the schema pretty-printed inside a code fence, rendered on the server
  parametersHtml: string;
};

export type McpServerSummary = {
  id: string;
  name: string;
  url: string;
  // the key file's name, null for a server with no key
  keyName: string | null;
  // whether the key file is present in the secrets directory
  hasKey: boolean;
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  // null for the limits' call timeout
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
  // what the server said about itself, "" when not given
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  // "" when the server sent none
  instructions: string;
  // the last good discovery
  checkedAt: number;
  lastChange: McpChange | null;
  refreshError: string | null;
  refreshFailedAt: number | null;
  createdAt: number;
  tools: McpToolSummary[];
};

// an agent's row for a server: the sides the agent may use
export type AgentServer = {
  serverId: string;
  read: boolean;
  write: boolean;
};
