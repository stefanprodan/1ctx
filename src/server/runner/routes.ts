// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The routes that start or stop a send. They live here rather than in
// sessions because the runner sits below it in the layer order and a
// route above calling down would be one more forward closure.

import type { SessionDetail } from "../../shared/contracts/session.ts";
import { jsonBody } from "../lib/body.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import {
  MAX_SESSION_BODY,
  parseCreateSession,
  parseSendMessage,
} from "../sessions/index.ts";

export type RoutesDeps = {
  start(
    principal: Principal,
    fields: { projectId: string; agentId: string; message: string },
  ): SessionDetail;
  send(principal: Principal, sessionId: string, message: string): SessionDetail;
  stop(principal: Principal, sessionId: string): void;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "POST",
      path: "/api/sessions",
      policy: "authenticated",
      async handle(req, ctx) {
        const fields = parseCreateSession(
          await jsonBody(req, MAX_SESSION_BODY),
        );
        return json(deps.start(ctx.principal!, fields), 201);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:id/messages",
      policy: "authenticated",
      async handle(req, ctx) {
        const { message } = parseSendMessage(
          await jsonBody(req, MAX_SESSION_BODY),
        );
        return json(deps.send(ctx.principal!, ctx.params.id, message), 201);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:id/stop",
      policy: "authenticated",
      handle(_req, ctx) {
        deps.stop(ctx.principal!, ctx.params.id);
        return json({});
      },
    },
  ];
}
