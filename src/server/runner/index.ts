// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner: a send from admission to its end. start() opens a chat
// with its first send, send() adds one to a chat, stop() ends the one
// holding the lock, and every one of them goes through the same
// registry, the same writer, the same tool loop and the same terminal
// transition. The areas it needs come as ports from compose.ts; the
// stream frames go out through the socket port. run() drives the loop;
// the lock is let go after both the provider iteration and the round's
// tools have settled.

import {
  applyChange,
  type CapabilityChange,
} from "../../shared/capabilities.ts";
import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  refuseArchived,
  type SessionRow,
  titleFrom,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { attention } from "./attention.ts";
import { compactSend } from "./compact.ts";
import { endSend, FINALIZE_ATTEMPTS, FINALIZE_RETRY_MS } from "./ending.ts";
import type { Event } from "./event.ts";
import { commitMemory } from "./memory-phase.ts";
import { type PreparedRun, prepareSend } from "./prepare.ts";
import { regenerateUser } from "./regenerate.ts";
import { Registry } from "./registry.ts";
import { ProviderRefusal, type RoundDeps } from "./round.ts";
import { routes } from "./routes.ts";
import { type ActiveSend, claim, live, type SendOp } from "./send.ts";
import { sendPolicy } from "./send-policy.ts";
import { shutdownRunner } from "./shutdown.ts";
import { type LoopDeps, toolLoop } from "./tool-loop.ts";
import type { Runner, RunnerDeps } from "./types.ts";
import { Writer } from "./writer.ts";

export type { AttentionPort } from "./attention.ts";
export type { Event } from "./event.ts";
export type { PreparedRun } from "./prepare.ts";
export { Registry, RunCapacity, type Running } from "./registry.ts";
export { type ActiveSend, live } from "./send.ts";
export type { ShutdownResult } from "./shutdown.ts";
export type { Runner, RunnerDeps } from "./types.ts";
export {
  HTML_EVERY_MS,
  statusOf,
  WRITE_EVERY_BYTES,
  WRITE_EVERY_MS,
  Writer,
} from "./writer.ts";

// how long shutdown waits for the streams to let go
export const SHUTDOWN_DRAIN_MS = 5000;
export { FINALIZE_ATTEMPTS, FINALIZE_RETRY_MS };

export function runnerArea(deps: RunnerDeps): Runner {
  const registry = new Registry();
  const asks = attention(deps.attention, deps.log);
  const writer = new Writer({
    db: deps.db,
    clock: deps.clock,
    sessions: deps.sessions,
    uploads: deps.uploads,
    usage: deps.usage,
    commitMemory: (send) => commitMemory({ memory: deps.memory }, send),
    views: {
      start: (sessionId, snapshot) =>
        deps.memory.startView(sessionId, snapshot),
      end: (sessionId) => deps.memory.endView(sessionId),
      resetSeen: (sessionId) => deps.memory.resetSeen(sessionId),
    },
    render: deps.render,
    stream: deps.stream,
  });
  const roundDeps: RoundDeps = {
    chat: deps.providers.chat,
    writer,
    lookups: {
      usernameOf: (userId) => deps.users.byId(userId)?.username ?? null,
      reasoningDetailsOf: (messageId, providerId, model) =>
        deps.sessions.reasoningDetails(messageId, providerId, model),
    },
    clock: deps.clock,
    log: deps.log,
  };
  const pause =
    deps.clock.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const historyOf = (send: ActiveSend) =>
    deps.sessions
      .messages(send.sessionId)
      .filter((row) => row.id !== send.round?.messageId);

  // The first cause wins. Stop and shutdown still abort a phase opened
  // after another cause claimed the send.
  const terminate = (
    send: ActiveSend,
    cause: SendCause,
    error: string | null = null,
  ): Promise<boolean> => {
    if (cause === "stop" || cause === "shutdown") send.ending.abort();
    claim(send, cause, error);
    return send.ended;
  };

  const loopDeps: LoopDeps = {
    round: roundDeps,
    writer,
    tools: deps.tools,
    clock: deps.clock,
    log: deps.log,
    historyOf,
    fail: (send, error) => {
      void terminate(send, "failure", error);
    },
  };
  const phaseDeps = {
    db: deps.db,
    clock: deps.clock,
    sessions: deps.sessions,
    round: roundDeps,
    writer,
    tools: deps.tools,
    log: deps.log,
    historyOf,
    pause,
  };

  const run = async (send: ActiveSend): Promise<void> => {
    let finalized = false;
    if (send.policy.deadlineMs !== null) {
      void pause(send.policy.deadlineMs).then(() => {
        void terminate(send, "deadline");
      });
    }
    try {
      try {
        const end = await toolLoop(loopDeps, send);
        void terminate(send, end.cause, end.error);
      } catch (error) {
        if (send.cause === null && error instanceof ProviderRefusal) {
          send.refusal = { status: error.status };
        }
        void terminate(
          send,
          "failure",
          error instanceof Error ? error.message : String(error),
        );
      }
      finalized = await endSend(
        { writer, phase: phaseDeps, pause, log: deps.log, attention: asks },
        send,
      );
    } finally {
      if (send.tools !== null) await send.tools.catch(() => {});
      send.letGo();
      const freed = finalized && registry.free(send);
      if (freed && send.terminal !== "shutdown") deps.wake();
    }
  };

  const policyFor = (
    sessionId: string,
    project: ProjectRow,
    user: UserRow,
    agent: AgentRow,
    event: Event | null = null,
    offerTools = true,
    disabledCapabilities: readonly string[] = [],
  ) =>
    sendPolicy(deps, {
      sessionId,
      project,
      user,
      agent,
      event,
      offerTools,
      disabledCapabilities,
    });

  const author = (principal: Principal): UserRow => {
    const user = deps.users.byId(principal.userId);
    if (user === null) throw new BadRequest("the user is gone");
    return user;
  };

  const agentOf = (id: string): AgentRow => {
    const agent = deps.agents.byId(id);
    if (agent === null) throw new BadRequest("no such agent");
    return agent;
  };

  const prepare = (
    sessionId: string,
    session: SessionRow | null,
    project: ProjectRow,
    user: UserRow,
    agent: AgentRow,
    text: string,
    title: string,
    event: Event | null = null,
    existingUser: Message | null = null,
    uploads?: readonly string[],
    capabilities?: CapabilityChange,
  ): PreparedRun => {
    const changed = applyChange(
      event?.automation.disabledCapabilities ??
        session?.disabledCapabilities ??
        [],
      capabilities,
    );
    if (!changed.ok) throw new BadRequest(changed.error);
    const op: SendOp =
      event !== null ? "run" : existingUser !== null ? "regenerate" : "message";
    return prepareSend({
      registry,
      startedBy: event?.source === "schedule" ? null : user.id,
      wake: deps.wake,
      writer,
      sessions: deps.sessions,
      log: deps.log,
      run: (send) => void run(send),
      sessionId,
      session,
      policy: policyFor(
        sessionId,
        project,
        user,
        agent,
        event,
        true,
        changed.set,
      ),
      op,
      text,
      title,
      kind: event === null ? "chat" : "run",
      origin: event === null ? "chat" : "automation",
      automationId: event?.automation.id ?? null,
      existingUser,
      uploads,
      capabilities,
      checkUploads: deps.uploads.checkUploads,
      startKept: (id, afterSeq) => deps.bash.startKept(id, afterSeq),
      now: deps.clock(),
    });
  };

  const begin = (
    sessionId: string,
    session: SessionRow | null,
    project: ProjectRow,
    user: UserRow,
    agent: AgentRow,
    text: string,
    title: string,
    existingUser: Message | null = null,
    uploads?: readonly string[],
    capabilities?: CapabilityChange,
  ): SessionDetail => {
    const prepared = prepare(
      sessionId,
      session,
      project,
      user,
      agent,
      text,
      title,
      null,
      existingUser,
      uploads,
      capabilities,
    );
    prepared.launch();
    return prepared.detail;
  };

  const liveOf = (sessionId: string) => {
    const send = registry.get(sessionId);
    return send === null || send.terminal !== null ? null : live(send);
  };

  const runner: Runner = {
    registry,
    start(principal, fields) {
      const project = deps.access.project(principal, fields.projectId);
      const user = author(principal);
      const agent = agentOf(fields.agentId);
      return begin(
        newId(),
        null,
        project,
        user,
        agent,
        fields.message,
        titleFrom(fields.message),
        null,
        fields.uploads,
        fields.capabilities,
      );
    },
    send(principal, sessionId, fields) {
      const session = deps.visible(principal, sessionId);
      if (session.origin === "automation") {
        throw new Conflict("a run cannot continue");
      }
      refuseArchived(session);
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      return begin(
        session.id,
        session,
        project,
        user,
        agent,
        fields.message,
        session.title,
        null,
        fields.uploads,
        fields.capabilities,
      );
    },
    regenerate(principal, sessionId, fields = {}) {
      const session = deps.visible(principal, sessionId);
      if (session.origin === "automation") {
        throw new Conflict("a run cannot regenerate");
      }
      refuseArchived(session);
      registry.locked(session.id);
      if (session.status === "running") {
        throw new Conflict("the chat is running");
      }
      const existingUser = regenerateUser(deps.sessions.messages(session.id));
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      return begin(
        session.id,
        session,
        project,
        user,
        agent,
        existingUser.content,
        session.title,
        existingUser,
        undefined,
        fields.capabilities,
      );
    },
    compact(principal, sessionId) {
      const session = deps.visible(principal, sessionId);
      if (session.origin === "automation") {
        throw new Conflict("a run cannot compact");
      }
      refuseArchived(session);
      registry.locked(session.id);
      if (session.status === "running") {
        throw new Conflict("the chat is running");
      }
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      const policy = policyFor(
        session.id,
        project,
        user,
        agent,
        null,
        false,
        session.disabledCapabilities,
      );
      return compactSend(
        { ...deps, registry, writer, run, wake: deps.wake },
        session,
        policy,
      );
    },
    startRun(event) {
      return prepare(
        newId(),
        null,
        event.project,
        event.user,
        event.agent,
        event.instructions,
        event.automation.name,
        event,
      );
    },
    stop(principal, sessionId) {
      const session = deps.visible(principal, sessionId);
      const send = registry.get(session.id);
      if (send !== null) void terminate(send, "stop");
    },
    stopAgent(agentId) {
      for (const send of registry.values()) {
        if (send.policy.agentId === agentId) void terminate(send, "stop");
      }
    },
    live: liveOf,
    shutdown: () =>
      shutdownRunner(
        registry,
        deps.clock,
        (send) => void terminate(send, "shutdown"),
        SHUTDOWN_DRAIN_MS,
        () => asks.close(),
      ),
    settled: () => asks.settled(),
    routes: [],
  };
  runner.routes = routes({
    start: (principal, fields) => runner.start(principal, fields),
    send: (principal, id, fields) => runner.send(principal, id, fields),
    regenerate: (principal, id, fields) =>
      runner.regenerate(principal, id, fields),
    compact: (principal, id) => runner.compact(principal, id),
    stop: (principal, id) => runner.stop(principal, id),
  });
  return runner;
}
