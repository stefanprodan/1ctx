// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sessions: the session, message and send rows, their reads, the
// rename, the deletion, and the boot repair of rows a crash left running. The
// runner below writes them through the store this area builds.

import type { Db } from "../db/index.ts";
import { transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { HttpError, NotFound } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { type AccessPort, detail, type LivePort, routes } from "./routes.ts";
import { offWire, type SessionRow, type UsagePort } from "./rows.ts";
import { SessionStore } from "./store.ts";

export {
  lineFrom,
  MAX_SESSION_BODY,
  parseCreateSession,
  parseMessage,
  parseMessageId,
  parseRenameSession,
  parseSendMessage,
  parseStreamQuery,
  titleFrom,
} from "./parse.ts";
export { type AccessPort, detail, type LivePort, routes } from "./routes.ts";
export {
  cutResult,
  offWire,
  RESULT_DISPLAY_CHARS,
  type RepairedSession,
  type ReplyFinish,
  type SessionRow,
  STREAM_LIMIT,
  type UsagePort,
} from "./rows.ts";
export { SessionStore } from "./store.ts";

export const RESTART_ERROR = "the server restarted";

export type SessionsDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  access: AccessPort;
  live: LivePort;
  usage: UsagePort;
};

export type Sessions = {
  store: SessionStore;
  // the session when the principal may see its project, else the one
  // 404 access throws for the project
  visible(principal: Principal, id: string): SessionRow;
  // the project id, or null: the socket's watch check
  sessionProject(principal: Principal, id: string): string | null;
  usesAgent(agentId: string): boolean;
  // end what a crash left running, before the first request; how many
  // sessions were touched
  repair(): number;
  routes: RouteDescriptor[];
};

export function sessionsArea(deps: SessionsDeps): Sessions {
  const store = new SessionStore(deps.db, deps.usage);
  const visible = (principal: Principal, id: string): SessionRow => {
    const session = store.byId(id);
    if (session === null) throw new NotFound("no such chat");
    try {
      deps.access.project(principal, session.projectId);
    } catch (err) {
      if (err instanceof HttpError) throw new NotFound("no such chat");
      throw err;
    }
    return session;
  };
  return {
    store,
    visible,
    sessionProject(principal, id) {
      try {
        return visible(principal, id).projectId;
      } catch (err) {
        if (err instanceof HttpError) return null;
        throw err;
      }
    },
    usesAgent: (agentId) => store.usesAgent(agentId),
    repair() {
      const touched = transact(deps.db, () => {
        const rows = store.repair(deps.clock(), RESTART_ERROR);
        return {
          result: rows,
          events: rows.map((repaired) => ({
            type: "session.changed" as const,
            data: {
              projectId: repaired.session.projectId,
              session: repaired.session,
              messages: repaired.messages.map(offWire),
              send: repaired.send,
            },
          })),
        };
      });
      if (touched.length > 0) {
        deps.log(`ended ${touched.length} chats left running by a restart`);
      }
      return touched.length;
    },
    routes: routes({
      db: deps.db,
      store,
      access: deps.access,
      live: deps.live,
      usage: deps.usage,
      visible,
    }),
  };
}

export { detail as sessionDetail };
