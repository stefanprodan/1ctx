// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sessions: the session, message and send rows, their reads, the
// rename, the deletion, and the boot repair of rows a crash left running. The
// runner below writes them through the store this area builds.

import type { Memory } from "../../shared/contracts/memory.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import { transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { HttpError, NotFound } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { MemorySnapshot } from "./memory.ts";
import {
  type AccessPort,
  detail,
  type LivePort,
  routes,
  type UploadsPort,
} from "./routes.ts";
import { offWire, type SessionRow, type UsagePort } from "./rows.ts";
import { SessionStore } from "./store.ts";

export {
  type FeedCursor,
  parseFeedCursor,
  parseRunsCursor,
  type RunsCursor,
} from "./cursor.ts";
export {
  chatMarkdown,
  type ExportRow,
  markdownFilename,
} from "./markdown.ts";
export { type MemorySnapshot, memorySnapshot } from "./memory.ts";
export {
  lineFrom,
  MAX_REGENERATE_BODY,
  MAX_SESSION_BODY,
  MAX_SMALL_BODY,
  parseCreateSession,
  parseForkSession,
  parseMessage,
  parseMessageId,
  parseRegenerate,
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
  agents: { byId(id: string): AgentRow | null };
  live: LivePort;
  usage: UsagePort;
  uploads: UploadsPort;
  isWrite: (name: string) => boolean;
};

export type Sessions = {
  store: SessionStore;
  // the session when the principal may see its project, else the one
  // 404 access throws for the project
  visible(principal: Principal, id: string): SessionRow;
  // the project id, or null: the socket's watch check
  sessionProject(principal: Principal, id: string): string | null;
  usesAgent(agentId: string): boolean;
  runInfo(sessionId: string): Memory["run"];
  memorySnapshot(projectId: string, sessionId: string): MemorySnapshot | null;
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
    runInfo(sessionId) {
      const row = deps.db
        .query<
          {
            sessionId: string;
            automationId: string | null;
            automationName: string | null;
          },
          [string]
        >(
          `select sessions.id as sessionId,
             automations.id as automationId,
             automations.name as automationName
           from sessions
           left join automations on automations.id = sessions.automation_id
           where sessions.id = ?`,
        )
        .get(sessionId);
      return row ?? null;
    },
    memorySnapshot: (projectId, sessionId) =>
      store.memorySnapshot(projectId, sessionId, deps.isWrite),
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
        deps.log.info("chats repaired", { chats: touched.length });
      }
      return touched.length;
    },
    routes: routes({
      db: deps.db,
      clock: deps.clock,
      agents: deps.agents,
      store,
      access: deps.access,
      live: deps.live,
      usage: deps.usage,
      uploads: deps.uploads,
      visible,
    }),
  };
}

export { detail as sessionDetail };
