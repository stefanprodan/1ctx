// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A queued message is its author's alone to edit or remove, an admin's
// included, each change naming the revision it saw so a start that took
// the row first wins. Home reads the caller's not-sent messages by
// their own query, never through the feed.

import type {
  DiscardNotSentResponse,
  NotSentResponse,
  QueuedResponse,
} from "../../shared/api/sessions.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, Forbidden } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import {
  MAX_SESSION_BODY,
  MAX_SMALL_BODY,
  parseEditQueued,
  parseQueuedId,
  parseRemoveQueued,
} from "./parse.ts";
import { onWire, type QueuedRow, queueChanged } from "./queued.ts";
import type { SessionRow } from "./rows.ts";
import type { SessionStore } from "./store.ts";

const GONE = "the message has started or was removed";
const CHANGED = "the message changed, reload it";

export type QueuedRoutesDeps = {
  db: Db;
  clock: Clock;
  store: SessionStore;
  visibleProjectIds(userId: string): string[] | null;
  visible(principal: Principal, id: string): SessionRow;
};

// in a transaction: the row when it is in the chat and the caller's
function own(
  store: SessionStore,
  principal: Principal,
  sessionId: string,
  id: string,
): QueuedRow {
  const row = store.queue.byId(id);
  if (row === null || row.sessionId !== sessionId) throw new Conflict(GONE);
  if (row.authorId !== principal.userId) {
    throw new Forbidden("only its author changes a waiting message");
  }
  return row;
}

export function queuedRoutes(deps: QueuedRoutesDeps): RouteDescriptor[] {
  const { store } = deps;
  const changed = (sessionId: string) => {
    const event = queueChanged(deps.db, store, sessionId);
    return event === null ? [] : [event];
  };
  return [
    {
      method: "PATCH",
      path: "/api/sessions/:id/queued/:queuedId",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        const id = parseQueuedId(ctx.params.queuedId);
        const fields = parseEditQueued(await jsonBody(req, MAX_SESSION_BODY));
        const edited = transact(deps.db, () => {
          const row = own(store, principal, session.id, id);
          if (row.state !== "queued") throw new Conflict("it was not sent");
          const next = store.queue.edit(
            row.id,
            fields.revision,
            fields.message,
            deps.clock(),
          );
          if (next === null) throw new Conflict(CHANGED);
          return { result: next, events: changed(session.id) };
        });
        const body: QueuedResponse = {
          queued: onWire(edited, principal.username),
        };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/sessions/:id/queued/:queuedId",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        const id = parseQueuedId(ctx.params.queuedId);
        const { revision } = parseRemoveQueued(
          await jsonBody(req, MAX_SMALL_BODY),
        );
        transact(deps.db, () => {
          const row = own(store, principal, session.id, id);
          if (!store.queue.remove(row.id, revision)) {
            throw new Conflict(CHANGED);
          }
          return { result: undefined, events: changed(session.id) };
        });
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/me/not-sent",
      policy: "authenticated",
      handle(_req, ctx) {
        const { userId } = ctx.principal!;
        const body: NotSentResponse = {
          rows: store.queue.notSentOf(
            userId,
            deps.visibleProjectIds(userId) ?? [],
          ),
        };
        return json(body);
      },
    },
    {
      // the caller's own rows alone, wherever they were written
      method: "DELETE",
      path: "/api/me/not-sent",
      policy: "authenticated",
      handle(_req, ctx) {
        const { userId } = ctx.principal!;
        const deleted = transact(deps.db, () => {
          const chats = store.queue.discardNotSent(userId);
          return {
            result: chats.length,
            events: [...new Set(chats)].flatMap(changed),
          };
        });
        const body: DiscardNotSentResponse = { deleted };
        return json(body);
      },
    },
  ];
}
