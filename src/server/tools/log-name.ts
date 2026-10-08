// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BUILTIN_TOOLS, EMAIL_TOOL, WEB_TOOLS } from "../../shared/words.ts";
import type { ToolCall } from "../providers/index.ts";
import { DELEGATE_TOOL } from "./builtin/delegate.ts";
import { mcpCallName } from "./builtin/mcp.ts";
import type { Offered } from "./types.ts";

const LOGGED_TOOLS: ReadonlySet<string> = new Set([
  ...BUILTIN_TOOLS,
  ...WEB_TOOLS,
  EMAIL_TOOL,
  DELEGATE_TOOL,
]);

// the name a log line may carry: a built-in's, or `mcp:` and the server's
// configured name for an offered MCP tool, whose own name is server text;
// never a name the model wrote
export function toolLogName(offered: Offered, call: ToolCall): string {
  const wire = mcpCallName(offered.mcp, call) ?? call.name;
  const server = offered.mcp.find((item) =>
    item.tools.some((tool) => tool.wireName === wire),
  );
  if (server !== undefined) return `mcp:${server.name}`;
  return LOGGED_TOOLS.has(call.name) ? call.name : "unknown";
}
