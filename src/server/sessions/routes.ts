// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Starting and stopping a send are the runner's routes.

import type {
  ChildWorkResponse,
  ForkSessionResponse,
  OpenedFileResponse,
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
import { refuseArchived } from "./archive.ts";
import { childOf, childWork } from "./child-work.ts";
import { detail } from "./detail.ts";
import { envelope } from "./envelope.ts";
import type { AlertQuery } from "./list.ts";
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
import { cutResult, type SessionRow } from "./rows.ts";
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
  // an archive leaves the chat's waiting messages to the queue, which
  // turns them not sent
  wakeQueue(): void;
  // the feed's Flagged pick
  alerts(query: AlertQuery): SessionsResponse;
};

function ownerOrAdmin(
  principal: Principal,
  session: SessionRow,
  verb: "renames" | "deletes",
): void {
  if (session.ownerId !== principal.userId && principal.role !== "admin") {
    throw new Forbidden(`only the owner or an admin ${verb} a chat`);
  }
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/sessions",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const query = parseStreamQuery(ctx.url);
        const { project, q } = query;
        const ids =
          project === null
            ? (deps.access.visibleProjectIds(principal.userId) ?? [])
            : [deps.access.project(principal, project).id];
        const body: SessionsResponse = query.attention
          ? deps.alerts({ projectIds: ids, q, before: query.alertBefore })
          : deps.store.list({
              projectIds: ids,
              q,
              origin: query.origin,
              before: query.before,
            });
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
          detail(
            deps.store,
            session,
            deps.live(session.id),
            deps.keptDays(),
            ctx.principal!.userId,
          ),
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
        // a subagent's tool row is read under its root, as its rows are
        if (
          message === null ||
          message.kind !== "tool" ||
          (message.sessionId !== session.id &&
            !childOf(deps.db, message.sessionId, session.id))
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
      // a subagent's rows, keyed by the chat's delegate row: the chat's
      // access is the child's, and the child's own id reaches nothing
      method: "GET",
      path: "/api/sessions/:id/messages/:messageId/child",
      policy: "authenticated",
      handle(_req, ctx) {
        const session = deps.visible(ctx.principal!, ctx.params.id);
        const messageId = parseMessageId(ctx.params.messageId);
        const message = deps.store.message(messageId);
        const childId =
          message?.sessionId === session.id &&
          message.kind === "tool" &&
          message.toolName === "delegate"
            ? (message.childSessionId ?? null)
            : null;
        const body: ChildWorkResponse | null =
          childId === null
            ? null
            : childWork(deps.db, childId, deps.store.messages(childId));
        if (body === null) throw new NotFound("no such subagent");
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
            ...detail(
              deps.store,
              session,
              null,
              deps.keptDays(),
              principal.userId,
            ),
            draftUploads,
          };
          return {
            result,
            events: [envelope(session, messages, null)],
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
        ownerOrAdmin(principal, session, "renames");
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
            events: [envelope(row, [], deps.store.lastSend(row.id))],
          };
        });
        return json(
          detail(
            deps.store,
            renamed,
            deps.live(renamed.id),
            deps.keptDays(),
            principal.userId,
          ),
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
            events: [envelope(row, [], deps.store.lastSend(row.id))],
          };
        });
        deps.wakeQueue();
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
        ownerOrAdmin(principal, session, "deletes");
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
