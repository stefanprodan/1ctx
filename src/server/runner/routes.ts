// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The routes that start or stop a send. They live here rather than in
// sessions because the runner sits below it in the layer order and a
// route above calling down would be one more forward closure.

import type {
  CreateSessionRequest,
  QueuedResponse,
  RegenerateRequest,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import { jsonBody, readBody } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import {
  MAX_REGENERATE_BODY,
  MAX_SESSION_BODY,
  parseCreateSession,
  parseRegenerate,
  parseSendMessage,
} from "../sessions/index.ts";

export type RoutesDeps = {
  start(principal: Principal, fields: CreateSessionRequest): SessionDetail;
  // the turn it started, 201, or the message queued behind a running
  // one, 202
  message(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ):
    | { status: 201; body: SessionDetail }
    | { status: 202; body: QueuedResponse };
  regenerate(
    principal: Principal,
    sessionId: string,
    fields: RegenerateRequest,
  ): SessionDetail;
  compact(principal: Principal, sessionId: string): SessionDetail;
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
        const fields = parseSendMessage(await jsonBody(req, MAX_SESSION_BODY));
        const answer = deps.message(ctx.principal!, ctx.params.id, fields);
        return json(answer.body, answer.status);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:id/regenerate",
      policy: "authenticated",
      async handle(req, ctx) {
        const text = await readBody(req, MAX_REGENERATE_BODY);
        let body: unknown = {};
        if (text !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            throw new BadRequest("body must be JSON");
          }
        }
        const fields = parseRegenerate(body);
        return json(
          deps.regenerate(ctx.principal!, ctx.params.id, fields),
          201,
        );
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:id/compact",
      policy: "authenticated",
      handle(_req, ctx) {
        return json(deps.compact(ctx.principal!, ctx.params.id));
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
