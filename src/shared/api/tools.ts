// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the tools routes, all for admins. A
// change applies to the next send; a send in flight keeps the set it
// started on.

import type {
  BuiltinToolSummary,
  SearchState,
  WebToolSummary,
} from "../contracts/tool.ts";
import type { WebAccess, WebAccessMode } from "../web.ts";
import type { SearchProvider } from "../words.ts";

// GET /api/tools, and what PATCH /api/tools/:name answers
export type ToolsResponse = {
  // webfetch and websearch are listed here, read-only like the rest
  builtin: BuiltinToolSummary[];
  access: WebAccess;
  search: SearchState;
  visualize: WebToolSummary;
};

// PATCH /api/tools/:name. `web` takes the mode and the domains, and
// `listed` needs at least one host, given or stored. `websearch` takes
// the provider, null for None. `visualize` takes its switch and hosts.
// Any other name, any other field and an empty body are a 400.
export type PatchToolRequest = {
  mode?: WebAccessMode;
  domains?: string[];
  provider?: SearchProvider | null;
  enabled?: boolean;
  hosts?: string[];
};
