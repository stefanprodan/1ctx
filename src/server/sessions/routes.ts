// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream, one session and its deletion. The routes that start or
// stop a send live in the runner, which sits below this area. What may
// be seen is access's call: a session in a project the caller may not
// see is the same 404 as one that is not there.

import type {
  SessionResponse,
  SessionsResponse,
} from "../../shared/api/sessions.ts";
import type { LiveSend } from "../../shared/contracts/session.ts";
import { type Db, transact } from "../db/index.ts";
import { Conflict, Forbidden } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { ProjectRow } from "../projects/index.ts";
import { parseStreamQuery } from "./parse.ts";
import type { SessionRow, SessionStore } from "./store.ts";

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
    messages: store.messages(session.id),
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
        const body: SessionsResponse = { sessions: deps.store.list(ids, q) };
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
      method: "DELETE",
      path: "/api/sessions/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        if (session.ownerId !== principal.userId) {
          throw new Forbidden("only the owner deletes a chat");
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
