// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The stream, one session, its rename and its deletion. The routes that
// start or stop a send live in the runner, which sits below this area.
// What may be seen is access's call: a session in a project the caller
// may not see is the same 404 as one that is not there. A team chat's
// rename and delete belong to its owner or an admin; a delete waits for
// the chat to end, a rename does not. Anyone who sees a chat may
// archive it, which makes it read-only for good.

import type {
  ForkSessionResponse,
  OpenedFileResponse,
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
import { archivedEvent, refuseArchived } from "./archive.ts";
import { chatMarkdown, markdownFilename } from "./markdown.ts";
import { openedFileResponse } from "./opened.ts";
import {
  MAX_SMALL_BODY,
  parseForkSession,
  parseMessageId,
  parseRenameSession,
  parseStreamQuery,
  parseVisualParams,
} from "./parse.ts";
import { cutResult, offWire, type SessionRow } from "./rows.ts";
import type { SessionStore } from "./store.ts";
import { readVisual } from "./visual.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
  visibleProjectIds(userId: string): string[] | null;
};

// the runner's snapshot of the send in flight, so a reader gets the
// whole partial in one answer; a closure, since the runner is built
// after this area
export type LivePort = (sessionId: string) => LiveSend | null;

export type UploadsPort = {
  copyUploads(
    sourceId: string,
    targetId: string,
    restage?: { userId: string; projectId: string; messageId: string },
    messageIds?: ReadonlyMap<string, string>,
  ): string[];
};

export type RoutesDeps = {
  db: Db;
  clock: Clock;
  agents: { byId(id: string): AgentRow | null };
  store: SessionStore;
  access: AccessPort;
  live: LivePort;
  uploads: UploadsPort;
  // the days an archived chat is kept, as the limit reads now
  keptDays(): number;
  // the session when the principal may see it, else the one 404
  visible(principal: Principal, id: string): SessionRow;
};

export function detail(
  store: SessionStore,
  session: SessionRow,
  live: LiveSend | null,
  keptDays: number,
): SessionResponse {
  return {
    session,
    forkedFrom: store.forkedFrom(session.id),
    messages: store.messages(session.id).map(offWire),
    send: store.lastSend(session.id),
    live,
    authors: store.authors(session.id),
    agents: store.agents(session.id),
    archive: store.archiveOf(session.id, keptDays),
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
        const { project, q, origin, before } = parseStreamQuery(ctx.url);
        const ids =
          project === null
            ? (deps.access.visibleProjectIds(principal.userId) ?? [])
            : [deps.access.project(principal, project).id];
        const body: SessionsResponse = deps.store.list(ids, q, origin, before);
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        return json(
          detail(deps.store, session, deps.live(session.id), deps.keptDays()),
        );
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
        // a packed row is decompressed here, one result at a time
        const text = deps.store.result(message.id) ?? "";
        const body: ToolResultResponse = {
          ...cutResult(text),
          bytes: Buffer.byteLength(text, "utf8"),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:id/messages/:messageId/files/:index",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        const params = parseVisualParams(ctx.params);
        const message = deps.store.message(params.messageId);
        const file =
          message?.sessionId === session.id && message.kind === "tool"
            ? deps.store.openedFile(message.id, params.index)
            : null;
        if (file === null) throw new NotFound("no such file");
        const body: OpenedFileResponse = openedFileResponse(file);
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:id/messages/:messageId/calls/:index/visual",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        const params = parseVisualParams(ctx.params);
        const message = deps.store.message(params.messageId);
        const visual =
          message?.sessionId === session.id
            ? readVisual(deps.db, message, params.index)
            : null;
        if (visual === null) throw new NotFound("no such visual");
        return json(visual);
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
          const { session, messages, messageIds, draft } = deps.store.fork({
            source,
            ...fields,
            ownerId: principal.userId,
            now: deps.clock(),
          });
          const draftUploads = deps.uploads.copyUploads(
            source.id,
            session.id,
            draft === null
              ? undefined
              : {
                  userId: principal.userId,
                  projectId: source.projectId,
                  messageId: fields.messageId,
                },
            messageIds,
          );
          const result: ForkSessionResponse = {
            ...detail(deps.store, session, null, deps.keptDays()),
            draftUploads,
          };
          return {
            result,
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
        refuseArchived(session);
        const { title } = parseRenameSession(
          await jsonBody(req, MAX_SMALL_BODY),
        );
        const renamed = transact(deps.db, () => {
          // a send never writes the title, so a rename under one is
          // safe: one more revision on the row, one envelope
          const current = deps.store.byId(session.id);
          if (current === null) throw new NotFound("no such chat");
          refuseArchived(current);
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
        return json(
          detail(deps.store, renamed, deps.live(renamed.id), deps.keptDays()),
        );
      },
    },
    {
      // anyone who sees the chat may archive it, for good; a run is
      // read-only once it ends, so it has nothing to archive
      method: "POST",
      path: "/api/sessions/:id/archive",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        transact(deps.db, () => {
          const current = deps.store.byId(session.id);
          if (current === null) throw new NotFound("no such chat");
          if (current.origin === "automation") {
            throw new Conflict("a run cannot be archived");
          }
          if (current.archived !== null) {
            throw new Conflict("the chat is archived already");
          }
          if (current.status === "running") {
            throw new Conflict("the chat is running, stop it first");
          }
          const row = deps.store.archive(
            current.id,
            "manual",
            principal.userId,
            deps.clock(),
          )!;
          return {
            result: undefined,
            events: [archivedEvent(row, deps.store.lastSend(row.id))],
          };
        });
        return new Response(null, { status: 204 });
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
          const deleted = deps.store.remove(session.id);
          if (deleted === "running") {
            throw new Conflict("the chat is running, stop it first");
          }
          return { result: undefined, events: deleted ? [deleted] : [] };
        });
        return json({});
      },
    },
  ];
}
