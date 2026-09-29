// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner's ports and the capability it answers.

import type {
  CreateSessionRequest,
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
import type { Registry } from "./registry.ts";
import type { RoundDeps } from "./round.ts";
import type { live } from "./send.ts";
import type { ShutdownResult } from "./shutdown.ts";
import type { WriterDeps } from "./writer.ts";

export type RunnerDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  access: { project(principal: Principal, id: string): ProjectRow };
  visible(principal: Principal, id: string): SessionRow;
  agents: { byId(id: string): AgentRow | null };
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
  registry?: Registry;
  // a run's slot let go for good, so a waiting fire may start
  slotFreed(): void;
  attention: AttentionPort;
};

export type Runner = {
  registry: Registry;
  start(principal: Principal, fields: CreateSessionRequest): SessionDetail;
  send(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): SessionDetail;
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
  // every send terminated with cause shutdown and its stream let go,
  // or the deadline passed
  shutdown(): Promise<ShutdownResult>;
  // every attention ask queued or in flight has ended
  settled(): Promise<void>;
  routes: RouteDescriptor[];
};
