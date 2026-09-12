// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner: a send from admission to its end. start() opens a chat
// with its first send, send() adds one to a chat, stop() ends the one
// holding the lock, and every one of them goes through the same
// registry, the same writer and the same terminal transition. The
// areas it needs come as ports from compose.ts; the stream frames go
// out through the socket port.

import type { SessionDetail } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  type SessionRow,
  type SessionStore,
  sessionDetail,
  titleFrom,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { buildPolicy } from "./policy.ts";
import { Registry } from "./registry.ts";
import type { RoundDeps } from "./round.ts";
import { runRound } from "./round.ts";
import { routes } from "./routes.ts";
import { type ActiveSend, claim, live, newSend } from "./send.ts";
import { Writer, type WriterDeps } from "./writer.ts";

export { MAX_RUNNING, MAX_RUNNING_PER_USER, Registry } from "./registry.ts";
export { type ActiveSend, live } from "./send.ts";
export {
  HTML_EVERY_MS,
  statusOf,
  WRITE_EVERY_BYTES,
  WRITE_EVERY_MS,
  Writer,
} from "./writer.ts";

// how long shutdown waits for the streams to let go
export const SHUTDOWN_DRAIN_MS = 5000;
export const FINALIZE_ATTEMPTS = 3;
export const FINALIZE_RETRY_MS = 100;

export type RunnerDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  access: { project(principal: Principal, id: string): ProjectRow };
  visible(principal: Principal, id: string): SessionRow;
  agents: { byId(id: string): AgentRow | null };
  users: { byId(id: string): UserRow | null };
  providers: { chat: RoundDeps["chat"] };
  usage: WriterDeps["usage"];
  render: WriterDeps["render"];
  stream: WriterDeps["stream"];
  registry?: Registry;
};

export type Runner = {
  registry: Registry;
  start(
    principal: Principal,
    fields: { projectId: string; agentId: string; message: string },
  ): SessionDetail;
  send(principal: Principal, sessionId: string, message: string): SessionDetail;
  stop(principal: Principal, sessionId: string): void;
  live: (sessionId: string) => ReturnType<typeof live> | null;
  // every send terminated with cause shutdown and its stream let go,
  // or the deadline passed
  shutdown(): Promise<void>;
  routes: RouteDescriptor[];
};

export function runnerArea(deps: RunnerDeps): Runner {
  const registry = deps.registry ?? new Registry();
  const writer = new Writer({
    db: deps.db,
    clock: deps.clock,
    sessions: deps.sessions,
    usage: deps.usage,
    render: deps.render,
    stream: deps.stream,
  });
  const roundDeps: RoundDeps = {
    chat: deps.providers.chat,
    writer,
    lookups: {
      usernameOf: (userId) => deps.users.byId(userId)?.username ?? null,
      reasoningDetailsOf: (messageId) =>
        deps.sessions.reasoningDetails(messageId),
    },
    clock: deps.clock,
  };

  const pause =
    deps.clock.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const finalizations = new WeakMap<ActiveSend, Promise<boolean>>();

  const finalize = async (
    send: ActiveSend,
    cause: SendCause,
    error: string | null,
  ): Promise<boolean> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < FINALIZE_ATTEMPTS; attempt++) {
      try {
        writer.finalizeSend(send, cause, error);
        return true;
      } catch (err) {
        lastError = err;
      }
      if (attempt + 1 < FINALIZE_ATTEMPTS) await pause(FINALIZE_RETRY_MS);
    }
    deps.log(
      `chat ${send.sessionId} could not be finalized: ${String(lastError)}`,
    );
    return false;
  };

  // the first cause owns the retries, so every caller observes the same end
  const terminate = (
    send: ActiveSend,
    cause: SendCause,
    error: string | null = null,
  ): Promise<boolean> => {
    const active = finalizations.get(send);
    if (active) return active;
    if (!claim(send, cause)) return Promise.resolve(false);
    const task = finalize(send, cause, error).then((finalized) => {
      deps.log(
        `chat ${send.sessionId} ${cause}${error === null ? "" : `: ${error}`}`,
      );
      return finalized;
    });
    finalizations.set(send, task);
    return task;
  };

  const run = async (send: ActiveSend): Promise<void> => {
    let finalized = false;
    try {
      // the reply row is the last one; everything before it is history
      const rows = deps.sessions
        .messages(send.sessionId)
        .filter((row) => row.id !== send.round.messageId);
      await runRound(roundDeps, send, rows);
      finalized = await terminate(send, "finish");
    } catch (err) {
      finalized = await terminate(
        send,
        "failure",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      send.letGo();
      if (finalized) registry.free(send);
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

  // admission and startSend in one turn, with no await between: the
  // lock is taken, the rows are written, the run begins
  const begin = (
    sessionId: string,
    session: SessionRow | null,
    project: ProjectRow,
    user: UserRow,
    agent: AgentRow,
    text: string,
  ): SessionDetail => {
    const policy = buildPolicy({ projectId: project.id, user, agent });
    registry.admit(sessionId, user.id);
    const now = deps.clock();
    let started: ReturnType<Writer["startSend"]>;
    const placeholder = newSend({
      id: newId(),
      sessionId,
      projectId: project.id,
      policy,
      firstMessageId: "",
      replyId: "",
      now,
    });
    registry.set(placeholder);
    try {
      started = writer.startSend({
        sessionId,
        session,
        title: titleFrom(text),
        policy,
        text,
      });
    } catch (err) {
      registry.free(placeholder);
      throw err;
    }
    const send: ActiveSend = {
      ...placeholder,
      id: started.send.id,
      firstMessageId: started.user.id,
      round: { ...placeholder.round, messageId: started.reply.id },
    };
    registry.set(send);
    deps.log(`chat ${sessionId} sent to ${agent.name} on ${policy.model}`);
    void run(send);
    return sessionDetail(deps.sessions, started.session, live(send));
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
      return begin(newId(), null, project, user, agent, fields.message);
    },
    send(principal, sessionId, message) {
      const session = deps.visible(principal, sessionId);
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      return begin(session.id, session, project, user, agent, message);
    },
    stop(principal, sessionId) {
      const session = deps.visible(principal, sessionId);
      const send = registry.get(session.id);
      if (send !== null) void terminate(send, "stop");
    },
    live: liveOf,
    async shutdown() {
      registry.close();
      const sends = registry.values();
      for (const send of sends) void terminate(send, "shutdown");
      const deadline = new Promise<void>((resolve) =>
        setTimeout(resolve, SHUTDOWN_DRAIN_MS),
      );
      await Promise.race([
        Promise.all(sends.map((send) => send.drained)),
        deadline,
      ]);
    },
    routes: [],
  };
  runner.routes = routes({
    start: (principal, fields) => runner.start(principal, fields),
    send: (principal, id, message) => runner.send(principal, id, message),
    stop: (principal, id) => runner.stop(principal, id),
  });
  return runner;
}
