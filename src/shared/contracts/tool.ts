// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool shapes that cross the wire. A ToolCall is what a model asked
// for: an id the result is paired back by, the tool's name and its
// arguments as the JSON string the provider streamed, kept verbatim so
// the answer round can send the calling turn back unchanged. The
// providers type re-exports ToolCall, so the runner and the browser
// name one shape.

import type { BuiltinTool, SearchProvider } from "../words.ts";

export type ToolCall = {
  // the id the model gave the call, echoed on the tool result
  id: string;
  // the tool the model named; a name the registry does not list is a
  // failed result, never a throw
  name: string;
  // the arguments as the provider's JSON string, kept as received
  arguments: string;
};

// a built-in as the tools page shows it: the schema the model gets,
// with the year already filled, and the server-wide switch. The text
// is read-only: the built-ins' words are the code's.
export type ToolSummary = {
  name: BuiltinTool;
  description: string;
  parameters: object;
  // Server-rendered so the browser does not ship a Markdown parser.
  parametersHtml: string;
  enabled: boolean;
  updatedAt: number;
};

// the search provider an admin chose, null when never chosen, and
// whether each provider's key file is there; the value never rides
export type SearchState = {
  provider: SearchProvider | null;
  keys: Record<SearchProvider, boolean>;
};
