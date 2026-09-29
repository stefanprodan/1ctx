// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sessions: the session, message and send rows, their reads, the
// rename, the deletion, and the boot repair of rows a crash left running. The
// runner below writes them through the store this area builds.

import type { AgentActivity } from "../../shared/api/agents.ts";
import type { McpServersUsage, McpUsage } from "../../shared/api/mcp.ts";
import type { EnvelopeRow } from "../../shared/api/sessions.ts";
import type { SkillLoads } from "../../shared/api/skills.ts";
import type { VisualCounts, WebCounts } from "../../shared/api/tools.ts";
import type { Memory } from "../../shared/contracts/memory.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import { transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { HttpError, NotFound } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { ChatCaps } from "../limits/index.ts";
import {
  agentActivity,
  mcpCalls,
  mcpServerCalls,
  personDays,
  skillLoads,
  visualCounts,
  webCounts,
} from "./activity.ts";
import { agentChats, agentRunning, archivedEvent } from "./archive.ts";
import { markAttention, runAnswer } from "./attention.ts";
import { queueChanged } from "./queued.ts";
import { queuedRoutes } from "./queued-routes.ts";
import {
  type AccessPort,
  detail,
  type LivePort,
  routes,
  type UploadsPort,
} from "./routes.ts";
import { offWire, type SessionRow, type UsagePort } from "./rows.ts";
import { SessionStore } from "./store.ts";
import { envelopeRow } from "./stream.ts";
import { type ChatSweep, type SweepScratch, sweepChats } from "./sweep.ts";

export { ARCHIVED, refuseArchived } from "./archive.ts";
export {
  parseFeedCursor,
  parseRunsCursor,
  type RunsCursor,
} from "./cursor.ts";
export {
  chatMarkdown,
  type ExportRow,
  markdownFilename,
} from "./markdown.ts";
export {
  lineFrom,
  MAX_REGENERATE_BODY,
  MAX_SESSION_BODY,
  MAX_SMALL_BODY,
  parseCreateSession,
  parseEditQueued,
  parseForkSession,
  parseMessage,
  parseMessageId,
  parseQueuedId,
  parseRegenerate,
  parseRemoveQueued,
  parseRenameSession,
  parseSendMessage,
  parseStreamQuery,
  titleFrom,
} from "./parse.ts";
export {
  MAX_QUEUED_PER_CHAT,
  NOT_SENT_KEPT_MS,
  onWire as queuedOnWire,
  type QueuedRow,
  type QueueLoad,
  QueueStore,
  queueChanged,
} from "./queued.ts";
export { type AccessPort, detail, type LivePort, routes } from "./routes.ts";
export {
  cutResult,
  offWire,
  RESULT_DISPLAY_CHARS,
  type ReplyFinish,
  type SessionRow,
  STREAM_LIMIT,
  type UsagePort,
} from "./rows.ts";
export { SessionStore } from "./store.ts";
export type { ChatSweep } from "./sweep.ts";

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
  scratch: SweepScratch;
  limits: { current(): { archivedDeleteDays: number } };
};

export type Sessions = {
  store: SessionStore;
  // the session when the principal may see its project, else the one
  // 404 access throws for the project
  visible(principal: Principal, id: string): SessionRow;
  // the project id, or null: the socket's watch check
  sessionProject(principal: Principal, id: string): string | null;
  // the stream row a session envelope carries, null for a session gone
  envelopeRow(sessionId: string): EnvelopeRow | null;
  // the chats an agent's delete archives and the sends it stops
  agentImpact(agentId: string): { chats: number; running: number };
  agentActivity(): AgentActivity[];
  // in the caller's transaction: every chat on the agent archived, one
  // envelope each
  archiveAgent(agentId: string, now: number): BusEvent[];
  // a person's posts, chats and manual runs on each day of a window,
  // in every project
  personDays(userId: string, starts: number[], until: number): number[];
  mcpCalls(server: string, since: number, until: number): McpUsage;
  mcpServerCalls(since: number, until: number): McpServersUsage;
  skillLoads(since: number, until: number): SkillLoads;
  visualCounts(since: number, until: number): VisualCounts;
  webCounts(since: number, until: number): WebCounts;
  sessionInfo(sessionId: string): Memory["session"];
  // a run's answer before its memory phase, null when it has none
  runAnswer(sendId: string, memoryRound: number | null): string | null;
  // a revision and one rows-free envelope, never activity; false when
  // the session is gone
  markAttention(sessionId: string, attention: number, by: string): boolean;
  // in the caller's transaction: the user's queued and not-sent messages
  // in a project they left, and one envelope per chat they were in
  dropQueued(projectId: string, userId: string): BusEvent[];
  // end what a crash left running, before the first request; how many
  // sessions were touched
  repair(): number;
  // the hourly chats sweep: idle chats archived, archived chats and
  // ended runs packed, scratch freed, archived chats and orphan runs
  // deleted past the limit; the counts go on the sweep event
  sweep(now: number, caps: ChatCaps): ChatSweep;
  routes: RouteDescriptor[];
};

export function sessionsArea(deps: SessionsDeps): Sessions {
  const store = new SessionStore(deps.db, deps.usage, deps.scratch);
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
    envelopeRow: (sessionId) => envelopeRow(deps.db, sessionId),
    agentImpact: (agentId) => ({
      chats: agentChats(deps.db, agentId).length,
      running: agentRunning(deps.db, agentId),
    }),
    agentActivity: () => agentActivity(deps.db),
    archiveAgent: (agentId, now) =>
      agentChats(deps.db, agentId).flatMap((id) => {
        const row = store.archive(id, "agent", null, now);
        return row === null ? [] : [archivedEvent(row, store.lastSend(row.id))];
      }),
    personDays: (userId, starts, until) =>
      personDays(deps.db, userId, starts, until),
    mcpCalls: (server, since, until) => mcpCalls(deps.db, server, since, until),
    mcpServerCalls: (since, until) => mcpServerCalls(deps.db, since, until),
    skillLoads: (since, until) => skillLoads(deps.db, since, until),
    visualCounts: (since, until) => visualCounts(deps.db, since, until),
    webCounts: (since, until) => webCounts(deps.db, since, until),
    sessionInfo(sessionId) {
      const row = deps.db
        .query<NonNullable<Memory["session"]>, [string]>(
          `select sessions.id as id, sessions.title as title,
             sessions.origin as origin,
             automations.id as automationId,
             automations.name as automationName
           from sessions
           left join automations on automations.id = sessions.automation_id
           where sessions.id = ?`,
        )
        .get(sessionId);
      return row ?? null;
    },
    runAnswer: (sendId, memoryRound) => runAnswer(deps.db, sendId, memoryRound),
    dropQueued: (projectId, userId) =>
      [...new Set(store.queue.dropInProject(projectId, userId))].flatMap(
        (sessionId) => queueChanged(deps.db, store, sessionId) ?? [],
      ),
    markAttention: (sessionId, attention, by) =>
      markAttention(deps.db, store, sessionId, attention, by),
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
    sweep: (now, caps) =>
      sweepChats(
        { db: deps.db, store, scratch: deps.scratch, log: deps.log },
        now,
        caps,
      ),
    routes: [
      ...routes({
        db: deps.db,
        clock: deps.clock,
        agents: deps.agents,
        store,
        access: deps.access,
        live: deps.live,
        uploads: deps.uploads,
        keptDays: () => deps.limits.current().archivedDeleteDays,
        visible,
      }),
      ...queuedRoutes({
        db: deps.db,
        clock: deps.clock,
        store,
        visibleProjectIds: (userId) => deps.access.visibleProjectIds(userId),
        visible,
      }),
    ],
  };
}

export { detail as sessionDetail };
