// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { RouteDescriptor } from "../lib/http.ts";
import type { McpServerDeps } from "./ports.ts";
import { routes } from "./routes.ts";
import { serve } from "./serve.ts";
import { skillCatalog } from "./skill.ts";

export type {
  AccessPort,
  KnowledgePort,
  McpServerDeps,
  ProjectsPort,
  SessionsPort,
  TasksPort,
} from "./ports.ts";
export { MCP_MESSAGES_PER_MINUTE } from "./routes.ts";

export type McpServerArea = {
  routes: RouteDescriptor[];
  close(): Promise<void>;
};

export function mcpServerArea(deps: McpServerDeps): McpServerArea {
  let handler: Promise<McpHttpHandler> | null = null;
  const current = () => {
    handler ??= skillCatalog(deps.log).then((skills) => serve(deps, skills));
    return handler;
  };
  return {
    routes: routes(deps, current),
    // a failed load leaves nothing to close, and shutdown must go on
    close: async () => {
      const current = await handler?.catch(() => null);
      await current?.close();
    },
  };
}
