// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner's ports and the capability it answers.

import type {
  CreateSessionRequest,
  QueuedResponse,
  RegenerateRequest,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { Wire } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { BashCapability } from "../bash/index.ts";
import type { Db } from "../db/index.ts";
import type { KnowledgeCapability } from "../knowledge/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { SessionRow, SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import type { AttentionPort } from "./attention.ts";
import type { Event } from "./event.ts";
import type { ToolsPort } from "./policy.ts";
import type { PreparedRun } from "./prepare.ts";
import type { Dispatcher } from "./queue.ts";
import type { Registry } from "./registry.ts";
import type { RoundDeps } from "./round.ts";
import type { live } from "./send.ts";
import type { DrainResult, ShutdownResult } from "./shutdown.ts";
import type { QueuedClaim } from "./start.ts";
import type { TurnMessage } from "./turn.ts";
import type { WriterDeps } from "./writer.ts";

export type RunnerDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  access: { project(principal: Principal, id: string): ProjectRow };
  visible(principal: Principal, id: string): SessionRow;
  agents: {
    byId(id: string): AgentRow | null;
    byName(name: string): AgentRow | null;
  };
  users: { byId(id: string): UserRow | null };
  providers: {
    chat: RoundDeps["chat"];
    byId(id: string): { name: string; wire: Wire } | null;
  };
  tools: ToolsPort;
  memory: Pick<
    MemoryCapability,
    "read" | "commit" | "view" | "startView" | "endView" | "resetSeen"
  >;
  knowledge: Pick<KnowledgeCapability, "snapshot">;
  bash: Pick<BashCapability, "startKept">;
  uploads: WriterDeps["uploads"] & {
    checkUploads(
      userId: string,
      projectId: string,
      ids: readonly string[],
    ): void;
  };
  limits: { current(): Limits };
  usage: WriterDeps["usage"];
  render: WriterDeps["render"];
  stream: WriterDeps["stream"];
  // a send's place let go, so a run waiting for one may start
  wake(): void;
  attention: AttentionPort;
};

export type MessageAnswer =
  | { status: 201; body: SessionDetail }
  | { status: 202; body: QueuedResponse };

export type Runner = {
  registry: Registry;
  start(principal: Principal, fields: CreateSessionRequest): SessionDetail;
  send(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): SessionDetail;
  // one turn opened by 1 to MAX_TURN_MESSAGES user messages in order,
  // each by its own author, counted against the first; a claim takes
  // the queued rows they came from in the same transaction
  sendTurn(
    sessionId: string,
    messages: readonly TurnMessage[],
    claim?: readonly QueuedClaim[],
    // the index of the author it counts against, the first by default
    starter?: number,
  ): SessionDetail;
  // a message: its turn when the chat is free, else queued behind it
  message(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): MessageAnswer;
  regenerate(
    principal: Principal,
    sessionId: string,
    fields?: RegenerateRequest,
  ): SessionDetail;
  compact(principal: Principal, sessionId: string): SessionDetail;
  startRun(event: Event): PreparedRun;
  stop(principal: Principal, sessionId: string): void;
  // every send on a deleted agent ends as a stop does
  stopAgent(agentId: string): void;
  live: (sessionId: string) => ReturnType<typeof live> | null;
  // no more admissions, then up to boundMs for the running sends and
  // their asks to end on their own; cut ends the wait
  drain(boundMs: number, cut?: Promise<void>): Promise<DrainResult>;
  // every send terminated with cause shutdown and its stream let go,
  // the asks aborted, then close, or the deadline passed
  shutdown(close?: () => Promise<void>): Promise<ShutdownResult>;
  // every attention ask queued or in flight has ended
  settled(): Promise<void>;
  // the messages waiting behind busy chats
  queue: Dispatcher;
  routes: RouteDescriptor[];
};
