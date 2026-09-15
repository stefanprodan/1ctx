// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  McpResponse,
  McpServerResponse,
  PatchMcpEndpoint,
  PatchMcpSettings,
} from "../../shared/api/mcp.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import {
  BadGateway,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { DiscoveryResult } from "./discover.ts";
import { parseCreate, parsePatch } from "./parse.ts";
import type { RefreshCoordinator, RefreshKind } from "./refresh.ts";
import { type McpServerRow, type McpServerStore, summary } from "./store.ts";

export type RoutesDeps = {
  store: McpServerStore;
  coordinator: RefreshCoordinator;
  clock: Clock;
  log: (line: string) => void;
  hasSecret: (name: string) => boolean;
  keys: () => string[];
  callTimeoutMs: () => number;
  render: (markdown: string, streaming?: boolean) => string;
  discover(
    endpoint: Pick<McpServerRow, "url" | "keyName">,
    signal: AbortSignal,
  ): Promise<DiscoveryResult>;
};

function gateway(error: unknown): BadGateway {
  return new BadGateway(error instanceof Error ? error.message : String(error));
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const show = (row: McpServerRow) => summary(row, deps.hasSecret, deps.render);
  const find = (id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such MCP server");
    return row;
  };
  const response = (row: McpServerRow): McpServerResponse => ({
    server: show(row),
  });
  function run<T>(
    id: string,
    kind: RefreshKind,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const taken = deps.coordinator.take(id, kind, work);
    if (taken.status === "busy") {
      throw new Conflict("the MCP server is refreshing");
    }
    if (taken.status === "closed") {
      throw new ServiceUnavailable("MCP is shutting down");
    }
    return taken;
  }
  return [
    {
      method: "GET",
      path: "/api/mcp",
      policy: "admin",
      handle() {
        const body: McpResponse = {
          servers: deps.store.list().map(show),
          keys: deps.keys(),
          callTimeoutMs: deps.callTimeoutMs(),
          loadedAt: deps.clock(),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/mcp",
      policy: "admin",
      async handle(req) {
        const fields = parseCreate(await jsonBody(req));
        const taken = run(`new:${fields.name}`, "candidate", async (signal) => {
          let found: DiscoveryResult;
          try {
            found = await deps.discover(fields, signal);
            signal.throwIfAborted();
          } catch (error) {
            throw gateway(error);
          }
          return deps.store.create(fields, found);
        });
        const row = await taken.promise;
        return json(response(row), 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/mcp/:id",
      policy: "admin",
      async handle(req, ctx) {
        const change = parsePatch(await jsonBody(req));
        const before = find(ctx.params.id);
        if ("url" in change || "keyName" in change) {
          const endpoint = change as PatchMcpEndpoint;
          const moved = {
            url: endpoint.url ?? before.url,
            keyName: "keyName" in endpoint ? endpoint.keyName! : before.keyName,
          };
          const taken = run(before.id, "candidate", async (signal) => {
            let found: DiscoveryResult;
            try {
              found = await deps.discover(moved, signal);
              signal.throwIfAborted();
            } catch (error) {
              if (signal.aborted && deps.store.byId(before.id) === null) {
                throw new NotFound("no such MCP server");
              }
              throw gateway(error);
            }
            return deps.store.applyDiscovery(before.id, found, moved);
          });
          const row = await taken.promise;
          if (row === null) throw new NotFound("no such MCP server");
          return json(response(row));
        }
        const row = deps.store.updateSettings(
          before.id,
          change as PatchMcpSettings,
        );
        if (row === null) throw new NotFound("no such MCP server");
        return json(response(row));
      },
    },
    {
      method: "POST",
      path: "/api/mcp/:id/refresh",
      policy: "admin",
      async handle(_req, ctx) {
        const before = find(ctx.params.id);
        const taken = run(before.id, "refresh", async (signal) => {
          let found: DiscoveryResult;
          try {
            found = await deps.discover(before, signal);
            signal.throwIfAborted();
          } catch (error) {
            if (signal.aborted && deps.store.byId(before.id) === null) {
              throw new NotFound("no such MCP server");
            }
            if (!signal.aborted) {
              const words =
                error instanceof Error ? error.message : String(error);
              deps.store.recordFailure(before.id, words, deps.clock());
              deps.log(`server ${before.name} refresh failed: ${words}`);
            }
            throw gateway(error);
          }
          return deps.store.applyDiscovery(before.id, found);
        });
        const row = await taken.promise;
        if (row === null) throw new NotFound("no such MCP server");
        return json(response(row));
      },
    },
    {
      method: "DELETE",
      path: "/api/mcp/:id",
      policy: "admin",
      handle(_req, ctx) {
        deps.coordinator.abort(ctx.params.id);
        const deleted = deps.store.deleteUnreferenced(ctx.params.id);
        if (deleted === "missing") throw new NotFound("no such MCP server");
        if (deleted === "referenced") {
          throw new Conflict("an agent uses the MCP server");
        }
        return new Response(null, { status: 204 });
      },
    },
  ];
}
