// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The dispatcher: a message sent to a chat whose turn is running waits
// as a queued row, and every wake starts each free chat's queue as one
// turn through sendTurn, before the scheduler hears the wake, so a due
// run never takes the place a user's message waits for. A wake is
// level-triggered: a pass reads the chats with queued rows, one indexed
// read when there are none, and a wake during a pass runs another. A
// queued row holds no place in any cap. A row that can no longer start
// turns not sent with its reason; one whose author lost the chat goes.
// One timer, set to the oldest row's expiry, expires rows in an idle
// process.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import type { NotSentReason } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import {
  BadRequest,
  Conflict,
  HttpError,
  TooManyRequests,
} from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { LIMIT_DEFINITIONS, type Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  MAX_QUEUED_PER_CHAT,
  type QueuedRow,
  queueChanged,
  queuedOnWire,
  refuseArchived,
  type SessionRow,
  type SessionStore,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { principalOf } from "./authors.ts";
import type { Registry } from "./registry.ts";
import type { QueuedClaim } from "./start.ts";
import type { TurnMessage } from "./turn.ts";

const MINUTE_MS = 60_000;
// passes one wake may run before it hands the rest to a later turn
const PASSES_PER_WAKE = 4;
// the chats one expiry read takes
const EXPIRE_PAGE = 64;
const SENDS_CEILING = LIMIT_DEFINITIONS.sendsRunning.max;

export type DispatcherDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  registry: Registry;
  limits: { current(): Limits };
  users: { byId(id: string): UserRow | null };
  agents: { byId(id: string): AgentRow | null };
  access: { project(principal: Principal, id: string): ProjectRow };
  visible(principal: Principal, id: string): SessionRow;
  uploads: {
    checkUploads(
      userId: string,
      projectId: string,
      ids: readonly string[],
    ): void;
  };
  sendTurn(
    sessionId: string,
    messages: readonly TurnMessage[],
    claim: readonly QueuedClaim[],
  ): void;
};

export type Dispatcher = {
  // expire what waited too long, start what can, set the timer
  start(): void;
  // no pass after this: a row left queued stays queued
  close(): void;
  wake(): void;
  // the message queued when the chat's lock is held, else null: the
  // chat is free, its own queue tried first, and the caller sends
  enqueue(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): QueuedMessage | null;
};

const waiting = (n: number, what: string) =>
  `${what} ${n === 1 ? "1 message" : `${n} messages`} waiting`;

export function dispatcher(deps: DispatcherDeps): Dispatcher {
  const { db, sessions, registry } = deps;
  const queue = sessions.queue;
  let started = false;
  let closed = false;
  let dispatching = false;
  let again = false;
  // the expiry timer: a token so a fake clock's sleep can be dropped
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedMinutes: number | null = null;

  const sees = (user: UserRow, projectId: string): boolean => {
    try {
      deps.access.project(principalOf(user), projectId);
      return true;
    } catch (err) {
      if (err instanceof HttpError) return false;
      throw err;
    }
  };

  const uploadsFail = (row: QueuedRow, user: UserRow, projectId: string) => {
    if (row.uploads.length === 0) return false;
    try {
      deps.uploads.checkUploads(user.id, projectId, row.uploads);
      return false;
    } catch (err) {
      if (err instanceof HttpError) return true;
      throw err;
    }
  };

  // one transaction: rows dropped, rows turned not sent, one envelope
  const settle = (
    sessionId: string,
    drop: readonly string[],
    notSent: ReadonlyMap<NotSentReason, readonly QueuedRow[]>,
  ): void => {
    if (drop.length === 0 && notSent.size === 0) return;
    const now = deps.clock();
    const counts = transact(db, () => {
      const dropped = queue.drop(drop);
      const turned = new Map<NotSentReason, number>();
      for (const [reason, rows] of notSent) {
        turned.set(reason, queue.notSend(rows, reason, now));
      }
      const event =
        dropped > 0 || [...turned.values()].some((n) => n > 0)
          ? queueChanged(db, sessions, sessionId)
          : null;
      return {
        result: { dropped, turned },
        events: event === null ? [] : [event],
      };
    });
    if (counts.dropped > 0) {
      deps.log.info("queue dropped", {
        chat: sessionId,
        messages: counts.dropped,
      });
    }
    for (const [reason, messages] of counts.turned) {
      if (messages === 0) continue;
      deps.log.info("queue not sent", { chat: sessionId, reason, messages });
    }
  };

  // the chat's queued rows sorted: those that can start, and the rest
  // settled
  const sort = (
    sessionId: string,
  ): { session: SessionRow; ready: QueuedRow[] } | null => {
    const rows = queue.waiting(sessionId);
    if (rows.length === 0) return null;
    const session = sessions.byId(sessionId);
    if (session === null) return null;
    const cutoff =
      deps.clock() - deps.limits.current().queuedMinutes * MINUTE_MS;
    const whole: NotSentReason | null =
      session.archived !== null
        ? session.archived.reason === "agent"
          ? "agent-deleted"
          : "archived"
        : deps.agents.byId(session.agentId) === null
          ? "agent-deleted"
          : null;
    const drop: string[] = [];
    const notSent = new Map<NotSentReason, QueuedRow[]>();
    const ready: QueuedRow[] = [];
    for (const row of rows) {
      const user = deps.users.byId(row.authorId);
      if (user !== null && !sees(user, session.projectId)) {
        drop.push(row.id);
        continue;
      }
      const reason: NotSentReason | null =
        whole ??
        (row.queuedAt <= cutoff
          ? "expired"
          : user === null ||
              user.disabled ||
              user.mustChangePassword ||
              uploadsFail(row, user, session.projectId)
            ? "failed"
            : null);
      if (reason === null) {
        ready.push(row);
        continue;
      }
      notSent.set(reason, [...(notSent.get(reason) ?? []), row]);
    }
    settle(session.id, drop, notSent);
    return { session, ready };
  };

  const startChat = (sessionId: string): void => {
    const sorted = sort(sessionId);
    if (sorted === null || sorted.ready.length === 0) return;
    const rows = sorted.ready;
    try {
      deps.sendTurn(
        sessionId,
        rows.map((row) => ({
          userId: row.authorId,
          message: row.text,
          ...(row.uploads.length > 0 ? { uploads: row.uploads } : {}),
          ...(row.capabilities === undefined
            ? {}
            : { capabilities: row.capabilities }),
        })),
        rows.map((row) => ({ id: row.id, revision: row.revision })),
      );
      deps.log.info("queue start", { chat: sessionId, messages: rows.length });
    } catch (err) {
      // a full cap, a held lock, a lost claim or a shutdown: the rows
      // wait for the next wake
      if (err instanceof TooManyRequests || err instanceof Conflict) return;
      settle(sessionId, [], new Map([["failed", rows]]));
      deps.log.warn("queue start failed", {
        chat: sessionId,
        messages: rows.length,
        ...errorFields(err, false),
      });
    }
  };

  const pass = (): void => {
    const held = registry.values().map((send) => send.sessionId);
    // the ceiling bounds the read, so a wake with nothing queued reads
    // nothing else; the cap bounds the starts
    const page = queue.waitingChats(held, SENDS_CEILING);
    if (page.length === 0) return;
    const limit = deps.limits.current().sendsRunning;
    for (const sessionId of page.slice(0, limit)) {
      if (closed) return;
      if (registry.get(sessionId) !== null) continue;
      try {
        startChat(sessionId);
      } catch (err) {
        deps.log.error("queue pass failed", {
          chat: sessionId,
          ...errorFields(err),
        });
      }
    }
  };

  // every chat with a row past its time, the running ones included
  const expire = (): void => {
    const tried = new Set<string>();
    for (;;) {
      const cutoff =
        deps.clock() - deps.limits.current().queuedMinutes * MINUTE_MS;
      const page = queue
        .expiredChats(cutoff, EXPIRE_PAGE + tried.size)
        .filter((id) => !tried.has(id));
      if (page.length === 0) return;
      for (const sessionId of page) {
        tried.add(sessionId);
        try {
          if (registry.get(sessionId) === null) startChat(sessionId);
          else sort(sessionId);
        } catch (err) {
          deps.log.error("queue expiry failed", {
            chat: sessionId,
            ...errorFields(err),
          });
        }
      }
    }
  };

  const disarm = () => {
    token++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    armedMinutes = null;
  };

  const arm = (): void => {
    disarm();
    if (closed) return;
    const oldest = queue.oldestQueuedAt();
    if (oldest === null) return;
    const minutes = deps.limits.current().queuedMinutes;
    armedMinutes = minutes;
    const mine = token;
    const ring = () => {
      if (mine !== token || closed) return;
      armedMinutes = null;
      expire();
      arm();
    };
    const ms = oldest + minutes * MINUTE_MS - deps.clock();
    if (ms <= 0) {
      queueMicrotask(ring);
    } else if (deps.clock.sleep !== undefined) {
      void deps.clock.sleep(ms).then(ring);
    } else {
      timer = setTimeout(ring, ms);
      timer.unref?.();
    }
  };

  const wake = (): void => {
    if (!started || closed) return;
    // a pass writes its own transactions, so never inside another
    if (db.inTransaction) {
      queueMicrotask(wake);
      return;
    }
    if (dispatching) {
      again = true;
      return;
    }
    dispatching = true;
    try {
      for (let i = 0; i < PASSES_PER_WAKE; i++) {
        again = false;
        pass();
        if (!again) break;
      }
      if (again) {
        again = false;
        queueMicrotask(wake);
      }
    } finally {
      dispatching = false;
    }
    // a moved wait moves the expiry
    if (
      armedMinutes !== null &&
      armedMinutes !== deps.limits.current().queuedMinutes
    ) {
      arm();
    }
  };

  const enqueue = (
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): QueuedMessage | null => {
    const session = deps.visible(principal, sessionId);
    if (session.origin === "automation") {
      throw new Conflict("a run cannot continue");
    }
    refuseArchived(session);
    // a queue a full cap left behind goes before the new message
    if (started && !closed && registry.get(session.id) === null) {
      startChat(session.id);
    }
    if (registry.get(session.id) === null) return null;
    const user = deps.users.byId(principal.userId);
    if (user === null) throw new BadRequest("the user is gone");
    if (fields.uploads?.length) {
      deps.uploads.checkUploads(user.id, session.projectId, fields.uploads);
    }
    const now = deps.clock();
    const queued = transact(db, () => {
      const mine = queue.userCount(user.id);
      if (mine >= deps.limits.current().queuedPerUser) {
        throw new TooManyRequests(
          `${waiting(mine, "You have")}. Send or discard one first.`,
        );
      }
      const rows = queue.waiting(session.id);
      if (rows.length >= MAX_QUEUED_PER_CHAT) {
        throw new TooManyRequests(
          `${waiting(rows.length, "This chat has")}. Try again when the reply ends.`,
        );
      }
      const taken = new Set(rows.flatMap((row) => row.uploads));
      if (fields.uploads?.some((id) => taken.has(id))) {
        throw new BadRequest("each file can be added to one message");
      }
      const row = queue.insert({
        sessionId: session.id,
        authorId: user.id,
        text: fields.message,
        uploads: fields.uploads,
        capabilities: fields.capabilities,
        now,
      });
      const event = queueChanged(db, sessions, session.id);
      return {
        result: queuedOnWire(row, user.username),
        events: event === null ? [] : [event],
      };
    });
    deps.log.info("queued", { chat: session.id, user: user.username });
    if (started && !closed && armedMinutes === null) arm();
    return queued;
  };

  return {
    start() {
      if (started || closed) return;
      started = true;
      expire();
      wake();
      arm();
    },
    close() {
      closed = true;
      disarm();
    },
    wake,
    enqueue,
  };
}
