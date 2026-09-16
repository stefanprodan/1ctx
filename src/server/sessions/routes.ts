// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream, one session, its rename and its deletion. The routes that
// start or stop a send live in the runner, which sits below this area.
// What may be seen is access's call: a session in a project the caller
// may not see is the same 404 as one that is not there. A team chat's
// rename and delete belong to its owner or an admin; a delete waits for
// the chat to end, a rename does not.

import type {
  SessionResponse,
  SessionsResponse,
  ToolResultResponse,
} from "../../shared/api/sessions.ts";
import type { LiveSend } from "../../shared/contracts/session.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, Forbidden, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import { parseZoneQuery } from "../usage/index.ts";
import { chatMarkdown, markdownFilename } from "./markdown.ts";
import {
  MAX_SMALL_BODY,
  parseForkSession,
  parseMessageId,
  parseRenameSession,
  parseStreamQuery,
} from "./parse.ts";
import { cutResult, offWire, type SessionRow, type UsagePort } from "./rows.ts";
import type { SessionStore } from "./store.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
  visibleProjectIds(userId: string): string[] | null;
};

// the runner's snapshot of the send in flight, so a reader gets the
// whole partial in one answer; a closure, since the runner is built
// after this area
export type LivePort = (sessionId: string) => LiveSend | null;

export type RoutesDeps = {
  db: Db;
  clock: Clock;
  agents: { byId(id: string): AgentRow | null };
  store: SessionStore;
  access: AccessPort;
  live: LivePort;
  usage: UsagePort;
  // the session when the principal may see it, else the one 404
  visible(principal: Principal, id: string): SessionRow;
};

export function detail(
  store: SessionStore,
  session: SessionRow,
  live: LiveSend | null,
): SessionResponse {
  return {
    session,
    forkedFrom: store.forkedFrom(session.id),
    messages: store.messages(session.id).map(offWire),
    send: store.lastSend(session.id),
    live,
  };
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/sessions",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const { project, q, origin } = parseStreamQuery(ctx.url);
        const ids =
          project === null
            ? (deps.access.visibleProjectIds(principal.userId) ?? [])
            : [deps.access.project(principal, project).id];
        const body: SessionsResponse = {
          rows: deps.store.list(ids, q, origin),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        return json(detail(deps.store, session, deps.live(session.id)));
      },
    },
    {
      // anyone who sees the chat may take it away; a reply in flight
      // is not in the file until it ends
      method: "GET",
      path: "/api/sessions/:id/markdown",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        const timeZone = parseZoneQuery(ctx.url);
        const body = chatMarkdown(
          session.title,
          deps.store.exportRows(session.id),
          timeZone,
        );
        return new Response(body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="${markdownFilename(session.title)}"`,
          },
        });
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:id/messages/:messageId/result",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        const messageId = parseMessageId(ctx.params.messageId);
        const message = deps.store.message(messageId);
        if (
          message === null ||
          message.sessionId !== session.id ||
          message.kind !== "tool"
        ) {
          throw new NotFound("no such tool result");
        }
        const body: ToolResultResponse = {
          ...cutResult(message.content),
          bytes: Buffer.byteLength(message.content, "utf8"),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/sessions/:id/fork",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        deps.visible(principal, ctx.params.id);
        const fields = parseForkSession(await jsonBody(req, MAX_SMALL_BODY));
        const body = transact(deps.db, () => {
          const source = deps.visible(principal, ctx.params.id);
          if (deps.agents.byId(fields.agentId) === null) {
            throw new BadRequest("no such agent");
          }
          const { session, messages } = deps.store.fork({
            source,
            ...fields,
            ownerId: principal.userId,
            now: deps.clock(),
          });
          return {
            result: detail(deps.store, session, null),
            events: [
              {
                type: "session.changed" as const,
                data: {
                  projectId: session.projectId,
                  session,
                  messages: messages.map(offWire),
                  send: null,
                },
              },
            ],
          };
        });
        return json(body, 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/sessions/:id",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        if (
          session.ownerId !== principal.userId &&
          principal.role !== "admin"
        ) {
          throw new Forbidden("only the owner or an admin renames a chat");
        }
        const { title } = parseRenameSession(
          await jsonBody(req, MAX_SMALL_BODY),
        );
        const renamed = transact(deps.db, () => {
          // a send never writes the title, so a rename under one is
          // safe: one more revision on the row, one envelope
          const current = deps.store.byId(session.id);
          if (current === null) throw new NotFound("no such chat");
          const row = deps.store.rename(session.id, title)!;
          return {
            result: row,
            events: [
              {
                type: "session.changed" as const,
                data: {
                  projectId: row.projectId,
                  session: row,
                  messages: [],
                  send: deps.store.lastSend(row.id),
                },
              },
            ],
          };
        });
        return json(detail(deps.store, renamed, deps.live(renamed.id)));
      },
    },
    {
      method: "DELETE",
      path: "/api/sessions/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        if (
          session.ownerId !== principal.userId &&
          principal.role !== "admin"
        ) {
          throw new Forbidden("only the owner or an admin deletes a chat");
        }
        transact(deps.db, () => {
          // the row is the truth after repair, and the runner keeps it
          // running while it holds the lock
          const current = deps.store.byId(session.id);
          if (current === null) return { result: undefined };
          if (current.status === "running") {
            throw new Conflict("the chat is running, stop it first");
          }
          deps.usage.deleteSession(session.id);
          deps.store.delete(session.id);
          return {
            result: undefined,
            events: [
              {
                type: "session.deleted" as const,
                data: { projectId: session.projectId, sessionId: session.id },
              },
            ],
          };
        });
        return json({});
      },
    },
  ];
}
