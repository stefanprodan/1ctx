// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner area: admission to finalize for every send.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { CapabilityChange } from "../../shared/capabilities.ts";
import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { after, sleep } from "../lib/clock.ts";
import { BadRequest, messageOf } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { ProjectRow } from "../projects/index.ts";
import { type SessionRow, titleFrom } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { attention } from "./attention.ts";
import { liveAuthor, principalOf } from "./authors.ts";
import { chatFor } from "./chat-guard.ts";
import { delegate } from "./child.ts";
import { compactSend } from "./compact.ts";
import { endSend, FINALIZE_RETRY_MS } from "./ending.ts";
import type { Event } from "./event.ts";
import { roundLookups } from "./lookups.ts";
import { commitMemory } from "./memory-phase.ts";
import { type PreparedRun, prepareSend } from "./prepare.ts";
import { dispatcher } from "./queue.ts";
import { regenerateUsers } from "./regenerate.ts";
import { Registry } from "./registry.ts";
import { mountRepos } from "./repos.ts";
import { ProviderRefusal, type RoundDeps } from "./round.ts";
import { routes } from "./routes.ts";
import { type ActiveSend, claim, live, type SendOp } from "./send.ts";
import { sendPolicy } from "./send-policy.ts";
import { drainRunner, shutdownRunner } from "./shutdown.ts";
import type { QueuedClaim, StartFields, StartUser } from "./start.ts";
import { refuseNewSummon, regeneratedAgent, turnAgent } from "./summon.ts";
import { type LoopDeps, toolLoop } from "./tool-loop.ts";
import { applyChanges, checkTurn, type TurnMessage } from "./turn.ts";
import type { Runner, RunnerDeps } from "./types.ts";
import { Writer } from "./writer.ts";

export type { Event } from "./event.ts";
export type { AlertChange, AlertsPort } from "./marks.ts";
export type { PreparedRun } from "./prepare.ts";
export { Registry, RunCapacity, type Running } from "./registry.ts";
export type { ActiveSend } from "./send.ts";
export type { DrainResult, ShutdownResult } from "./shutdown.ts";
export { MAX_TURN_MESSAGES, type TurnMessage } from "./turn.ts";
export type { Runner } from "./types.ts";

// how long shutdown waits for the streams to let go
export const SHUTDOWN_DRAIN_MS = 5000;
export { FINALIZE_RETRY_MS };

export function runnerArea(deps: RunnerDeps): Runner {
  const registry = new Registry();
  const asks = attention(deps.attention, deps.log);
  // a child's rows reach no watcher yet; the parent's watchers will get
  // them here, keyed by the delegate row (link.rowId)
  const childRows = (): BusEvent[] => [];
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
    alerts: deps.alerts,
    childRows,
  });
  const roundDeps: RoundDeps = {
    chat: deps.providers.chat,
    writer,
    ...roundLookups(deps),
    clock: deps.clock,
    log: deps.log,
  };
  const pause = (ms: number) => sleep(deps.clock, ms).promise;
  const historyOf = (send: ActiveSend) =>
    deps.sessions
      .messages(send.sessionId)
      .filter((row) => row.id !== send.round?.messageId);

  // The first cause wins. Stop and shutdown still abort a phase opened
  // after another cause claimed the send, and the send remembers it, so
  // its end leaves the open alert as a stop's would.
  const terminate = (
    send: ActiveSend,
    cause: SendCause,
    error: string | null = null,
  ): Promise<boolean> => {
    if (cause === "stop" || cause === "shutdown") {
      if (send.cause !== null && send.terminal === null) {
        send.interrupted = true;
      }
      send.ending.abort();
    }
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
  const childDeps = {
    db: deps.db,
    clock: deps.clock,
    log: deps.log,
    sessions: deps.sessions,
    loop: loopDeps,
    ending: { writer, pause, log: deps.log },
    bash: deps.bash,
    registry,
    sendsRunning: () => deps.limits.current().sendsRunning,
    wake: deps.wake,
    childRows,
    messages: (sessionId: string) => deps.sessions.messages(sessionId),
  };
  const reposDeps = {
    repos: deps.repos,
    sessions: deps.sessions,
    fileBytes: () => deps.limits.current().repoFileBytes,
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
  };

  const run = async (send: ActiveSend): Promise<void> => {
    let finalized = false;
    const disarm =
      send.policy.deadlineMs === null
        ? () => {}
        : after(deps.clock, send.policy.deadlineMs, () => {
            void terminate(send, "deadline");
          });
    try {
      try {
        await mountRepos(reposDeps, send);
        const end = await toolLoop(loopDeps, send);
        void terminate(send, end.cause, end.error);
      } catch (error) {
        if (send.cause === null && error instanceof ProviderRefusal) {
          send.refusal = { status: error.status };
        }
        void terminate(send, "failure", messageOf(error));
      }
      finalized = await endSend(
        { writer, phase: phaseDeps, pause, log: deps.log, attention: asks },
        send,
      );
    } finally {
      // a pending deadline would hold the whole send until it rang
      disarm();
      if (send.tools !== null) await send.tools.catch(() => {});
      // no command runs past here, so the trees may go
      send.repos?.release();
      send.letGo();
      const freed = finalized && registry.free(send);
      if (freed && send.terminal !== "shutdown") deps.wake();
    }
  };

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

  const prepare = (fields: {
    sessionId: string;
    session: SessionRow | null;
    project: ProjectRow;
    // who starts it: the first author, the regenerator, the automation's
    user: UserRow;
    agent: AgentRow;
    // the chat's agent, when the agent was summoned for the turn
    summoned?: string | null;
    title: string;
    event?: Event | null;
    turn: StartFields["turn"];
    changes: readonly (CapabilityChange | undefined)[];
    claim?: readonly QueuedClaim[];
    probe?: boolean;
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
      db: deps.db,
      registry,
      // a run no one pressed takes the scheduled share of the caps
      startedBy: event === null || event.source === "manual" ? user.id : null,
      wake: deps.wake,
      writer,
      sessions: deps.sessions,
      log: deps.log,
      run: (send) => void run(send),
      sessionId: fields.sessionId,
      session,
      policy: sendPolicy(deps, {
        ...fields,
        event,
        disabledCapabilities: disabled,
      }),
      op,
      turn,
      changes: fields.changes,
      ...(fields.claim === undefined ? {} : { claim: fields.claim }),
      probe: fields.probe === true,
      title: fields.title,
      kind: event === null ? "chat" : "run",
      origin: event === null ? "chat" : "automation",
      automationId: event?.automation.id ?? null,
      checkUploads: deps.uploads.checkUploads,
      startKept: (id, afterSeq) => deps.bash.startKept(id, afterSeq),
      now: deps.clock(),
    });
  };

  const launched = (prepared: PreparedRun): SessionDetail => {
    prepared.launch();
    return prepared.detail;
  };
  const begin = (fields: Parameters<typeof prepare>[0]): SessionDetail =>
    launched(prepare(fields));

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

  const continueChat = (
    sessionId: string,
    messages: readonly (SendMessageRequest & {
      principal: Principal;
      // the author's row when the caller read it already
      user?: UserRow;
    })[],
    claim?: readonly QueuedClaim[],
    // the author the turn counts against and whose policy it runs under
    starter = 0,
    probe = false,
  ): PreparedRun => {
    let session: SessionRow | null = null;
    let project: ProjectRow | null = null;
    const authors: UserRow[] = [];
    for (const { principal, user } of messages) {
      const seen = chatFor(deps, principal, sessionId, "continue");
      const own = deps.access.project(principal, seen.projectId);
      session ??= seen;
      project ??= own;
      authors.push(user ?? author(principal));
    }
    const first = session!;
    return prepare({
      sessionId: first.id,
      session: first,
      project: project!,
      user: authors[starter]!,
      ...turnAgent(
        deps,
        first.id,
        agentOf(first.agentId),
        messages.map((fields) => fields.message),
      ),
      title: first.title,
      turn: {
        users: messages.map((fields, i) =>
          newUser(authors[i]!, fields.message, fields.uploads),
        ),
      },
      changes: messages.map((fields) => fields.capabilities),
      ...(claim === undefined ? {} : { claim }),
      probe,
    });
  };

  const prepareTurn = (
    sessionId: string,
    messages: readonly TurnMessage[],
    claim?: readonly QueuedClaim[],
    starter?: number,
    probe?: boolean,
  ): PreparedRun => {
    checkTurn(messages);
    return continueChat(
      sessionId,
      messages.map(({ userId, ...fields }) => {
        const user = liveAuthor(deps.users.byId(userId));
        return { ...fields, user, principal: principalOf(user) };
      }),
      claim,
      starter,
      probe,
    );
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
      refuseNewSummon(deps.agents, agent.name, fields.message);
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
      return launched(continueChat(sessionId, [{ ...fields, principal }]));
    },
    sendTurn(sessionId, messages, claim, starter) {
      return launched(prepareTurn(sessionId, messages, claim, starter));
    },
    message(principal, sessionId, fields) {
      const queued = runner.queue.enqueue(principal, sessionId, fields);
      return queued === null
        ? { status: 201, body: runner.send(principal, sessionId, fields) }
        : { status: 202, body: queued };
    },
    regenerate(principal, sessionId, fields = {}) {
      const session = chatFor(
        deps,
        principal,
        sessionId,
        "regenerate",
        registry,
      );
      const existing = regenerateUsers(deps.sessions.messages(session.id));
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const lastId = existing.at(-1)!.userId;
      return begin({
        sessionId: session.id,
        session,
        project,
        user,
        ...regeneratedAgent(
          deps,
          session.id,
          agentOf(session.agentId),
          existing[0]!.sendId,
        ),
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
      const session = chatFor(deps, principal, sessionId, "compact", registry);
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const policy = sendPolicy(deps, {
        sessionId: session.id,
        project,
        user,
        agent: agentOf(session.agentId),
        offerTools: false,
        disabledCapabilities: session.disabledCapabilities,
      });
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
    delegate(input, call, ctx) {
      // the send of the call's session, started when the call's was
      const parent =
        ctx.actor === null ? null : registry.get(ctx.actor.sessionId);
      if (parent === null || parent.startedAt !== ctx.actor?.sendStartedAt) {
        throw new Error("the turn has ended");
      }
      return delegate(childDeps, parent, input, call, ctx);
    },
    live: liveOf,
    drain: (boundMs, cut = new Promise<void>(() => {})) =>
      drainRunner(registry, deps.clock, deps.log, boundMs, asks, cut),
    shutdown: (close) =>
      shutdownRunner(
        registry,
        deps.clock,
        (send) => void terminate(send, "shutdown"),
        SHUTDOWN_DRAIN_MS,
        () => asks.close(),
        close,
      ),
    settled: () => asks.settled(),
    queue: null!,
    routes: [],
  };
  runner.queue = dispatcher({
    ...deps,
    registry,
    prepareTurn,
  });
  runner.routes = routes({
    start: (principal, fields) => runner.start(principal, fields),
    message: (principal, id, fields) => runner.message(principal, id, fields),
    regenerate: (principal, id, fields) =>
      runner.regenerate(principal, id, fields),
    compact: (principal, id) => runner.compact(principal, id),
    stop: (principal, id) => runner.stop(principal, id),
  });
  return runner;
}
