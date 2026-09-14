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

import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import type { SendCause } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import type { Principal, RouteDescriptor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  type SessionRow,
  type SessionStore,
  sessionDetail,
  titleFrom,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { buildPolicy, type ToolsPort } from "./policy.ts";
import { Registry } from "./registry.ts";
import type { RoundDeps } from "./round.ts";
import { routes } from "./routes.ts";
import { type ActiveSend, claim, live, newSend } from "./send.ts";
import { type LoopDeps, toolLoop } from "./tool-loop.ts";
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
  tools: ToolsPort;
  limits: { current(): Limits };
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
  regenerate(principal: Principal, sessionId: string): SessionDetail;
  compact(principal: Principal, sessionId: string): SessionDetail;
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

  const loopDeps: LoopDeps = {
    round: roundDeps,
    writer,
    tools: deps.tools,
    clock: deps.clock,
    // the reply row in flight is the last one; everything before it is
    // history the wire takes
    historyOf: (send) =>
      deps.sessions
        .messages(send.sessionId)
        .filter((row) => row.id !== send.round?.messageId),
    // Claim failure before waiting for sibling tools, so their shared
    // signal aborts while allSettled still holds the session lock.
    fail: (send, error) => {
      void terminate(send, "failure", error);
    },
  };

  const run = async (send: ActiveSend): Promise<void> => {
    let finalized = false;
    try {
      const end = await toolLoop(loopDeps, send);
      finalized = await terminate(send, end.cause, end.error);
    } catch (err) {
      finalized = await terminate(
        send,
        "failure",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // the lock is let go only after the round's tools have settled too
      if (send.tools !== null) await send.tools.catch(() => {});
      send.letGo();
      if (finalized) registry.free(send);
    }
  };

  const policyFor = (project: ProjectRow, user: UserRow, agent: AgentRow) =>
    buildPolicy({
      project,
      user,
      agent,
      now: deps.clock(),
      tools: agent.model.tools ? deps.tools : null,
      limits: deps.limits.current(),
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

  // admission and startSend in one turn, with no await between: the
  // lock is taken, the ids are generated, the rows are written, the run
  // begins
  const begin = (
    sessionId: string,
    session: SessionRow | null,
    project: ProjectRow,
    user: UserRow,
    agent: AgentRow,
    text: string,
    existingUser: Message | null = null,
  ): SessionDetail => {
    const now = deps.clock();
    const policy = policyFor(project, user, agent);
    registry.admit(sessionId, user.id);
    const sendId = newId();
    const userId = existingUser?.id ?? newId();
    const replyId = newId();
    const send = newSend({
      id: sendId,
      sessionId,
      projectId: project.id,
      policy,
      firstMessageId: userId,
      replyId,
      now,
    });
    registry.set(send);
    let started: ReturnType<Writer["startSend"]>;
    try {
      started = writer.startSend({
        sendId,
        replyId,
        userId,
        sessionId,
        session,
        ...(existingUser === null ? {} : { existingUser }),
        title: titleFrom(text),
        policy,
        text,
      });
    } catch (err) {
      registry.free(send);
      throw err;
    }
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
    regenerate(principal, sessionId) {
      const session = deps.visible(principal, sessionId);
      const active = registry.get(session.id);
      if (active !== null) registry.admit(session.id, principal.userId);
      if (session.status === "running") {
        throw new Conflict("the chat is running");
      }
      const messages = deps.sessions.messages(session.id);
      if (messages.length === 0 || messages.at(-1)?.kind === "user") {
        throw new BadRequest("nothing to regenerate");
      }
      let existingUser: Message | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.kind === "user") {
          existingUser = messages[i]!;
          break;
        }
      }
      if (existingUser === null) {
        throw new BadRequest("nothing to regenerate");
      }
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
        existingUser,
      );
    },
    compact(principal, sessionId) {
      const session = deps.visible(principal, sessionId);
      const active = registry.get(session.id);
      if (active !== null) registry.admit(session.id, principal.userId);
      if (session.status === "running") {
        throw new Conflict("the chat is running");
      }
      const messages = deps.sessions.messages(session.id);
      let lastSummarySeq = 0;
      let lastUser: Message | null = null;
      let hasAnswer = false;
      for (const message of messages) {
        if (message.kind === "summary" && message.status === "done") {
          lastSummarySeq = message.seq;
          hasAnswer = false;
        } else if (
          message.kind === "reply" &&
          message.status === "done" &&
          message.slot === "answer" &&
          message.seq > lastSummarySeq
        ) {
          hasAnswer = true;
        }
        if (message.kind === "user") lastUser = message;
      }
      if (!hasAnswer || lastUser === null) {
        throw new BadRequest("nothing to compact");
      }
      const project = deps.access.project(principal, session.projectId);
      const user = author(principal);
      const agent = agentOf(session.agentId);
      const policy = policyFor(project, user, agent);
      registry.admit(session.id, user.id);
      const sendId = newId();
      const summaryId = newId();
      const send = newSend({
        id: sendId,
        sessionId: session.id,
        projectId: project.id,
        kind: "compact",
        summarizing: true,
        // the last counted round is the size the history has now
        used:
          session.usage === null
            ? null
            : session.usage.promptTokens + session.usage.completionTokens,
        policy,
        firstMessageId: lastUser.id,
        replyId: summaryId,
        now: deps.clock(),
      });
      registry.set(send);
      let started: ReturnType<Writer["startCompact"]>;
      try {
        started = writer.startCompact({
          sendId,
          summaryId,
          firstMessageId: lastUser.id,
          session,
          policy,
        });
      } catch (err) {
        registry.free(send);
        throw err;
      }
      deps.log(`chat ${session.id} compacted on ${policy.model}`);
      void run(send);
      return sessionDetail(deps.sessions, started.session, live(send));
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
    regenerate: (principal, id) => runner.regenerate(principal, id),
    compact: (principal, id) => runner.compact(principal, id),
    stop: (principal, id) => runner.stop(principal, id),
  });
  return runner;
}
