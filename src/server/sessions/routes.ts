// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream, one session, its rename and its deletion. The routes that
// start or stop a send live in the runner, which sits below this area.
// What may be seen is access's call: a session in a project the caller
// may not see is the same 404 as one that is not there. A rename and a
// delete are the owner's, neither while the chat runs, and a delete
// only in a personal project until a team project's rule is decided.

import type {
  SessionResponse,
  SessionsResponse,
  ToolResultResponse,
} from "../../shared/api/sessions.ts";
import type { LiveSend } from "../../shared/contracts/session.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { Conflict, Forbidden, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  parseMessageId,
  parseRenameSession,
  parseStreamQuery,
} from "./parse.ts";
import { cutResult, offWire, type SessionRow } from "./rows.ts";
import type { SessionStore } from "./store.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
  visibleProjectIds(userId: string): string[] | null;
};

// the runner's snapshot of the send in flight, so a reader gets the
// whole partial in one answer; a closure, since the runner is built
// after this area
export type LivePort = (sessionId: string) => LiveSend | null;

// the rename body: the title plus the JSON around it
const MAX_RENAME_BODY = 1024;

export type RoutesDeps = {
  db: Db;
  store: SessionStore;
  access: AccessPort;
  live: LivePort;
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
        const { project, q } = parseStreamQuery(ctx.url);
        const ids =
          project === null
            ? (deps.access.visibleProjectIds(principal.userId) ?? [])
            : [deps.access.project(principal, project).id];
        const body: SessionsResponse = { rows: deps.store.list(ids, q) };
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
      method: "PATCH",
      path: "/api/sessions/:id",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        if (session.ownerId !== principal.userId) {
          throw new Forbidden("only the owner renames a chat");
        }
        const { title } = parseRenameSession(
          await jsonBody(req, MAX_RENAME_BODY),
        );
        const renamed = transact(deps.db, () => {
          // nothing changes under a send: the row is the truth for that
          const current = deps.store.byId(session.id);
          if (current === null) throw new NotFound("no such chat");
          if (current.status === "running") {
            throw new Conflict("the chat is running; stop it first");
          }
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
        if (session.ownerId !== principal.userId) {
          throw new Forbidden("only the owner deletes a chat");
        }
        const project = deps.access.project(principal, session.projectId);
        if (project.kind !== "personal") {
          throw new Forbidden("a team chat cannot be deleted yet");
        }
        transact(deps.db, () => {
          // the row is the truth after repair, and the runner keeps it
          // running while it holds the lock
          const current = deps.store.byId(session.id);
          if (current === null) return { result: undefined };
          if (current.status === "running") {
            throw new Conflict("the chat is running; stop it first");
          }
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
