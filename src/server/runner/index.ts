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

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { CapabilityChange } from "../../shared/capabilities.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
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
import { regenerateUsers } from "./regenerate.ts";
import { Registry } from "./registry.ts";
import { ProviderRefusal, type RoundDeps } from "./round.ts";
import { routes } from "./routes.ts";
import { type ActiveSend, claim, live, type SendOp } from "./send.ts";
import { sendPolicy } from "./send-policy.ts";
import { shutdownRunner } from "./shutdown.ts";
import type { StartFields, StartUser } from "./start.ts";
import { type LoopDeps, toolLoop } from "./tool-loop.ts";
import { applyChanges, checkTurn } from "./turn.ts";
import type { Runner, RunnerDeps } from "./types.ts";
import { Writer } from "./writer.ts";

export type { AttentionPort } from "./attention.ts";
export type { Event } from "./event.ts";
export type { PreparedRun } from "./prepare.ts";
export { Registry, RunCapacity, type Running } from "./registry.ts";
export { type ActiveSend, live } from "./send.ts";
export type { ShutdownResult } from "./shutdown.ts";
export { MAX_TURN_MESSAGES, type TurnMessage } from "./turn.ts";
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

  // a message written earlier starts as its author is now: a role
  // changed, a login disabled or a project left since counts
  const liveAuthor = (userId: string): UserRow => {
    const user = deps.users.byId(userId);
    if (user === null) throw new BadRequest("the user is gone");
    if (user.disabled) throw new BadRequest("the user is disabled");
    return user;
  };
  const principalOf = (user: UserRow): Principal => ({
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    // no login stands behind a message that starts later
    loginId: "",
  });

  const agentOf = (id: string): AgentRow => {
    const agent = deps.agents.byId(id);
    if (agent === null) throw new BadRequest("no such agent");
    return agent;
  };

  const prepare = (fields: {
    sessionId: string;
    session: SessionRow | null;
    project: ProjectRow;
    // who starts it: the first author, the regenerator, the automation's
    user: UserRow;
    agent: AgentRow;
    title: string;
    event?: Event | null;
    turn: StartFields["turn"];
    changes: readonly (CapabilityChange | undefined)[];
  }): PreparedRun => {
    const { event = null, session, user, turn } = fields;
    const disabled = applyChanges(
      event?.automation.disabledCapabilities ??
        session?.disabledCapabilities ??
        [],
      fields.changes,
    );
    const op: SendOp =
      event !== null ? "run" : "existing" in turn ? "regenerate" : "message";
    return prepareSend({
      registry,
      startedBy: event?.source === "schedule" ? null : user.id,
      wake: deps.wake,
      writer,
      sessions: deps.sessions,
      log: deps.log,
      run: (send) => void run(send),
      sessionId: fields.sessionId,
      session,
      policy: policyFor(
        fields.sessionId,
        fields.project,
        user,
        fields.agent,
        event,
        true,
        disabled,
      ),
      op,
      turn,
      changes: fields.changes,
      title: fields.title,
      kind: event === null ? "chat" : "run",
      origin: event === null ? "chat" : "automation",
      automationId: event?.automation.id ?? null,
      checkUploads: deps.uploads.checkUploads,
      startKept: (id, afterSeq) => deps.bash.startKept(id, afterSeq),
      now: deps.clock(),
    });
  };

  const begin = (fields: Parameters<typeof prepare>[0]): SessionDetail => {
    const prepared = prepare(fields);
    prepared.launch();
    return prepared.detail;
  };

  const newUser = (
    user: UserRow,
    text: string,
    uploads?: readonly string[],
  ): StartUser => ({
    id: newId(),
    userId: user.id,
    username: user.username,
    text,
    ...(uploads === undefined ? {} : { uploads }),
  });

  // every author sees the chat and may write in its project; the turn
  // counts against the first
  const continueChat = (
    sessionId: string,
    messages: readonly (SendMessageRequest & {
      principal: Principal;
      // the author's row when the caller read it already
      user?: UserRow;
    })[],
  ): SessionDetail => {
    let session: SessionRow | null = null;
    let project: ProjectRow | null = null;
    const authors: UserRow[] = [];
    for (const { principal, user } of messages) {
      const seen = deps.visible(principal, sessionId);
      if (seen.origin === "automation") {
        throw new Conflict("a run cannot continue");
      }
      refuseArchived(seen);
      const own = deps.access.project(principal, seen.projectId);
      session ??= seen;
      project ??= own;
      authors.push(user ?? author(principal));
    }
    const first = session!;
    return begin({
      sessionId: first.id,
      session: first,
      project: project!,
      user: authors[0]!,
      agent: agentOf(first.agentId),
      title: first.title,
      turn: {
        users: messages.map((fields, i) =>
          newUser(authors[i]!, fields.message, fields.uploads),
        ),
      },
      changes: messages.map((fields) => fields.capabilities),
    });
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
      return begin({
        sessionId: newId(),
        session: null,
        project,
        user,
        agent,
        title: titleFrom(fields.message),
        turn: { users: [newUser(user, fields.message, fields.uploads)] },
        changes: [fields.capabilities],
      });
    },
    send(principal, sessionId, fields) {
      return continueChat(sessionId, [{ ...fields, principal }]);
    },
    sendTurn(sessionId, messages) {
      checkTurn(messages);
      return continueChat(
        sessionId,
        messages.map(({ userId, ...fields }) => {
          const user = liveAuthor(userId);
          return { ...fields, user, principal: principalOf(user) };
        }),
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
      const existing = regenerateUsers(deps.sessions.messages(session.id));
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      const lastId = existing.at(-1)!.userId;
      return begin({
        sessionId: session.id,
        session,
        project,
        user,
        agent,
        title: session.title,
        turn: {
          existing,
          // the line names who wrote the message, not who regenerated it
          lastAuthor:
            lastId === null || lastId === user.id
              ? user.username
              : (deps.users.byId(lastId)?.username ?? user.username),
        },
        changes: [fields.capabilities],
      });
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
      return prepare({
        sessionId: newId(),
        session: null,
        project: event.project,
        user: event.user,
        agent: event.agent,
        title: event.automation.name,
        event,
        turn: { users: [newUser(event.user, event.instructions)] },
        changes: [],
      });
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
