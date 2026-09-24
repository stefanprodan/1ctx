// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool shapes that cross the wire. A ToolCall is what a model asked
// for: an id the result is paired back by, the tool's name and its
// arguments as the JSON string the provider streamed, kept verbatim so
// the answer round can send the calling turn back unchanged. The
// providers type re-exports ToolCall, so the runner and the browser
// name one shape.

import type { BuiltinTool, SearchProvider, WebTool } from "../words.ts";

export const DEFAULT_VISUAL_HOSTS = [
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://unpkg.com",
] as const;

export type ToolCall = {
  // the id the model gave the call, echoed on the tool result
  id: string;
  // the tool the model named; a name the registry does not list is a
  // failed result, never a throw
  name: string;
  // the arguments as the provider's JSON string, kept as received
  arguments: string;
  // an opaque token a provider put on the call, sent back as received,
  // never shown
  signature?: string;
};

// when a send carries a built-in: always, when the agent has skills,
// when one of them has files, when MCP runs as a catalog, in an own-note
// phase, or in every send of a project for the knowledge base
export type ToolWhen =
  | "always"
  | "knowledge"
  | "skills"
  | "skillFiles"
  | "mcpCatalog"
  | "memory"
  // while the send has web access, and for websearch a provider too
  | "web"
  | "webSearch";

// a tool as the tools page shows it: the schema the model gets, with
// the year already filled, and its tokens as the wire carries it. The
// text is read-only: the built-ins' words are the code's.
type ToolSchema = {
  description: string;
  parameters: object;
  // Server-rendered so the browser does not ship a Markdown parser.
  parametersHtml: string;
  tokens: number;
};

// a built-in, never switched: a schema naming skills or MCP tools is
// counted with no names; a variant is a second text the tool may carry
export type BuiltinToolSummary = ToolSchema & {
  name: BuiltinTool | "webfetch" | "websearch";
  when: ToolWhen;
  // the tool lists names a send fills in, each adding tokens
  names: boolean;
  variant: { description: string; tokens: number } | null;
};

// visualize, the one tool with a server-wide switch of its own
export type WebToolSummary = ToolSchema & {
  name: Extract<WebTool, "visualize">;
  enabled: boolean;
  hosts: string[];
  updatedAt: number;
};

// the search provider an admin chose, null when never chosen, and
// whether each provider's key file is there; the value never rides
export type SearchState = {
  provider: SearchProvider | null;
  keys: Record<SearchProvider, boolean>;
};
