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
import type { SearchProvider } from "../words.ts";

// GET /api/tools, and what PATCH /api/tools/:name answers
export type ToolsResponse = {
  builtin: BuiltinToolSummary[];
  web: WebToolSummary[];
  search: SearchState;
};

// PATCH /api/tools/:name, a web tool alone: the switch, and for
// websearch the provider; a provider on webfetch is a 400, as is an
// empty body
export type PatchToolRequest = {
  enabled?: boolean;
  provider?: SearchProvider | null;
};
