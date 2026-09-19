// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PatchToolRequest,
  ToolsResponse,
} from "../../shared/api/tools.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { parseToolName, parseToolPatch, type ToolName } from "./parse.ts";
import { visualShell } from "./visual-shell.ts";

export type RoutesDeps = {
  clock: Clock;
  response(now: number): ToolsResponse;
  patch(name: ToolName, patch: PatchToolRequest, now: number): void;
  visualHosts(): string[];
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/visual",
      policy: "authenticated",
      handle(req) {
        return visualShell(deps.visualHosts(), req);
      },
    },
    {
      method: "GET",
      path: "/api/tools",
      policy: "admin",
      handle() {
        return json(deps.response(deps.clock()));
      },
    },
    {
      method: "PATCH",
      path: "/api/tools/:name",
      policy: "admin",
      async handle(req, ctx) {
        const name = parseToolName(ctx.params.name);
        const patch = parseToolPatch(await jsonBody(req), name);
        const now = deps.clock();
        deps.patch(name, patch, now);
        return json(deps.response(now));
      },
    },
  ];
}
