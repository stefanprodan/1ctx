// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { RouteDescriptor } from "../lib/http.ts";
import type { McpServerDeps } from "./ports.ts";
import { routes } from "./routes.ts";
import { serve } from "./serve.ts";

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
  let handler: ReturnType<typeof serve> | null = null;
  const current = () => {
    handler ??= serve(deps);
    return handler;
  };
  return {
    routes: routes(deps, current),
    close: () => handler?.close() ?? Promise.resolve(),
  };
}
