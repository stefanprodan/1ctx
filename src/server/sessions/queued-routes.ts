// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DiscardNotSentResponse,
  NotSentResponse,
  QueuedResponse,
  QueuedRowResponse,
  QueueState,
} from "../../shared/api/sessions.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, Forbidden } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import {
  MAX_SESSION_BODY,
  MAX_SMALL_BODY,
  parseDiscardNotSent,
  parseEditQueued,
  parseQueuedId,
  parseRemoveQueued,
} from "./parse.ts";
import { chatQueue, onWire, type QueuedRow, queueChanged } from "./queued.ts";
import type { SessionRow } from "./rows.ts";
import type { SessionStore } from "./store.ts";
import { type SummonAgents, summonOf } from "./summon.ts";

const GONE = "the message has started or was removed";
const CHANGED = "the message changed since it was shown";

export type QueuedRoutesDeps = {
  db: Db;
  clock: Clock;
  agents: SummonAgents;
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

// in the change's transaction: its events, and the caller's queue at
// the revision it made. A change to a queued row goes to the chat's
// watchers; one to the caller's not-sent row to their own tabs alone
export function queueAnswer(
  db: Db,
  store: SessionStore,
  sessionId: string,
  userId: string,
  notSent: boolean,
): { state: QueueState; events: BusEvent[] } {
  const events = queueChanged(
    db,
    sessionId,
    notSent ? { shared: false, authors: [userId] } : { shared: true },
  );
  return {
    state: {
      queue: chatQueue(db, sessionId, userId),
      revision: store.byId(sessionId)?.revision ?? 0,
    },
    events,
  };
}

export function queuedRoutes(deps: QueuedRoutesDeps): RouteDescriptor[] {
  const { store } = deps;
  return [
    {
      // the author's row whole, where a socket frame carried it cut
      method: "GET",
      path: "/api/sessions/:id/queued/:queuedId",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        const id = parseQueuedId(ctx.params.queuedId);
        const row = own(store, principal, session.id, id);
        const body: QueuedRowResponse = {
          queued: onWire(row, principal.username),
        };
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/sessions/:id/queued/:queuedId",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const session = deps.visible(principal, ctx.params.id);
        const id = parseQueuedId(ctx.params.queuedId);
        const fields = parseEditQueued(await jsonBody(req, MAX_SESSION_BODY));
        const body: QueuedResponse = transact(deps.db, () => {
          const row = own(store, principal, session.id, id);
          if (row.state !== "queued") throw new Conflict("it was not sent");
          // the runner's check, so an edit is refused as a send would be
          const chatAgent = deps.agents.byId(session.agentId);
          if (chatAgent !== null) {
            summonOf(deps.agents, chatAgent.name, fields.message);
          }
          const next = store.queue.edit(
            row.id,
            fields.revision,
            fields.message,
            deps.clock(),
          );
          if (next === null) throw new Conflict(CHANGED);
          const { state, events } = queueAnswer(
            deps.db,
            store,
            session.id,
            principal.userId,
            false,
          );
          return {
            result: { ...state, queued: onWire(next, principal.username) },
            events,
          };
        });
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
        const body: QueueState = transact(deps.db, () => {
          const row = own(store, principal, session.id, id);
          if (!store.queue.remove(row.id, revision)) {
            throw new Conflict(CHANGED);
          }
          const { state, events } = queueAnswer(
            deps.db,
            store,
            session.id,
            principal.userId,
            row.state === "not-sent",
          );
          return { result: state, events };
        });
        return json(body);
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
      // the caller's own rows alone, the ones named
      method: "DELETE",
      path: "/api/me/not-sent",
      policy: "authenticated",
      async handle(req, ctx) {
        const { userId } = ctx.principal!;
        const { ids } = parseDiscardNotSent(
          await jsonBody(req, MAX_SMALL_BODY),
        );
        const deleted = transact(deps.db, () => {
          const chats = store.queue.discardNotSent(
            userId,
            ids,
            deps.visibleProjectIds(userId) ?? [],
          );
          return {
            result: chats.length,
            events: [...new Set(chats)].flatMap((chat) =>
              queueChanged(deps.db, chat, { shared: false, authors: [userId] }),
            ),
          };
        });
        const body: DiscardNotSentResponse = { deleted };
        return json(body);
      },
    },
  ];
}
