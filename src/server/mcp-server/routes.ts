// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import skill from "../../../skills/external-tasks/SKILL.md" with {
  type: "text",
};
import { EXTERNAL_TASKS_SKILL_PATH } from "../../shared/skills.ts";
import { RateLimit } from "../access/index.ts";
import { MAX_KNOWLEDGE_BODY } from "../knowledge/index.ts";
import { jsonBody } from "../lib/body.ts";
import { MINUTE_MS } from "../lib/clock.ts";
import { TooManyRequests } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";

export const MCP_MESSAGES_PER_MINUTE = 120;

const messages = (body: unknown): number =>
  Array.isArray(body) ? Math.max(1, body.length) : 1;

// the request's signal ends a search its client left
function authInfo(principal: KeyPrincipal, signal: AbortSignal): AuthInfo {
  return {
    token: principal.via.id,
    clientId: principal.userId,
    scopes: [principal.via.scope],
    extra: { principal, signal },
  };
}

const methodNotAllowed = () => json({ error: "method not allowed" }, 405);

export function routes(
  deps: McpServerDeps,
  handler: () => McpHttpHandler,
): RouteDescriptor[] {
  const rate = new RateLimit(MCP_MESSAGES_PER_MINUTE, MINUTE_MS);
  return [
    {
      method: "POST",
      path: "/mcp",
      policy: "key",
      async handle(req, ctx) {
        const principal = ctx.principal as KeyPrincipal;
        const now = deps.clock();
        if (!rate.hit(principal.via.id, now)) {
          throw new TooManyRequests();
        }
        const body = await jsonBody(req, MAX_KNOWLEDGE_BODY);
        let admitted = true;
        for (let index = 1; index < messages(body); index++) {
          if (!rate.hit(principal.via.id, now)) admitted = false;
        }
        if (!admitted) throw new TooManyRequests();
        return handler().fetch(req, {
          parsedBody: body,
          authInfo: authInfo(principal, req.signal),
        });
      },
    },
    {
      method: "GET",
      path: "/mcp",
      policy: "key",
      handle: methodNotAllowed,
    },
    {
      method: "DELETE",
      path: "/mcp",
      policy: "key",
      handle: methodNotAllowed,
    },
    // public: curl carries no cookie, and the text is the repo's own
    {
      method: "GET",
      // served from the build it runs, so it names only the tools this has
      path: EXTERNAL_TASKS_SKILL_PATH,
      policy: "public",
      handle: () =>
        new Response(skill, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    },
  ];
}
