// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The dispatcher: a message sent to a chat whose turn is running waits
// as a queued row, and every wake starts each free chat's queue as one
// turn through sendTurn, before the scheduler hears the wake, so a due
// run never takes the place a user's message waits for. A wake is
// level-triggered: a pass reads the chats with queued rows, one indexed
// read when there are none, and a wake during a pass runs another. A
// queued row holds no place in any cap. A full cap, the lock or a lost
// claim leaves the rows queued; any other refusal turns the rows that
// cause it not sent, each found by a start tried in a transaction that
// is rolled back, and the rest start. One whose author lost the chat
// goes. One timer, set to the oldest row's expiry, expires rows in an
// idle process.

import type { SendMessageRequest } from "../../shared/api/sessions.ts";
import type { QueuedMessage } from "../../shared/contracts/session.ts";
import type { NotSentReason } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, HttpError } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { LIMIT_DEFINITIONS, type Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  type QueuedRow,
  queueChanged,
  refuseArchived,
  type SessionRow,
  type SessionStore,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { principalOf } from "./authors.ts";
import { queueMessage } from "./enqueue.ts";
import type { PreparedRun } from "./prepare.ts";
import { CapFull, LockHeld, type Registry, RunCapacity } from "./registry.ts";
import { ClaimLost, type QueuedClaim } from "./start.ts";
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
  // the turn prepared and not launched; a probe is not admitted, since
  // it only asks whether the rows start
  prepareTurn(
    sessionId: string,
    messages: readonly TurnMessage[],
    claim: readonly QueuedClaim[],
    starter: number,
    probe?: boolean,
  ): PreparedRun;
};

// what one chat's start came to; a full process ends the pass
type Outcome = "none" | "started" | "waits" | "process";

// the refusals that leave the rows queued for a later wake, by class
const keeps = (err: unknown): boolean =>
  err instanceof CapFull ||
  err instanceof RunCapacity ||
  err instanceof LockHeld ||
  err instanceof ClaimLost;

const processFull = (err: unknown): boolean =>
  (err instanceof CapFull || err instanceof RunCapacity) &&
  err.cap === "process";

// a probe's own throw, which rolls its transaction back
const PROBED = new Error("probed");

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
  // one later wake at a time, on a macrotask so others run between
  let later = false;
  const wakeLater = () => {
    if (later || closed) return;
    later = true;
    setTimeout(() => {
      later = false;
      wake();
    }, 0);
  };

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

  const messagesOf = (rows: readonly QueuedRow[]): TurnMessage[] =>
    rows.map((row) => ({
      userId: row.authorId,
      message: row.text,
      ...(row.uploads.length > 0 ? { uploads: row.uploads } : {}),
      ...(row.capabilities === undefined
        ? {}
        : { capabilities: row.capabilities }),
    }));
  const claimsOf = (rows: readonly QueuedRow[]): QueuedClaim[] =>
    rows.map((row) => ({ id: row.id, revision: row.revision }));

  // the turn counts against its oldest author with room under their own
  // cap, so a capped author never holds back the others
  const starterOf = (rows: readonly QueuedRow[]): number => {
    const cap = deps.limits.current().sendsPerUser;
    return rows.findIndex((row) => registry.startedBy(row.authorId) < cap);
  };

  // the start's refusal, or null once it launched
  const launch = (sessionId: string, rows: readonly QueuedRow[]) => {
    const starter = starterOf(rows);
    if (starter < 0) return new CapFull("user", "every author is busy");
    try {
      deps
        .prepareTurn(sessionId, messagesOf(rows), claimsOf(rows), starter)
        .launch();
      return null;
    } catch (err) {
      return err;
    }
  };

  // the start's refusal, or null, with nothing written
  const probe = (sessionId: string, rows: readonly QueuedRow[]) => {
    try {
      transact(db, () => {
        deps
          .prepareTurn(sessionId, messagesOf(rows), claimsOf(rows), 0, true)
          .abandon();
        throw PROBED;
      });
      return null;
    } catch (err) {
      return err === PROBED ? null : err;
    }
  };

  // the rows the refusal came from, each tried after those that pass
  const culprits = (sessionId: string, rows: readonly QueuedRow[]) => {
    const pass: QueuedRow[] = [];
    const failing: QueuedRow[] = [];
    for (const row of rows) {
      if (probe(sessionId, [...pass, row]) === null) pass.push(row);
      else failing.push(row);
    }
    return { pass, failing };
  };

  const fail = (
    sessionId: string,
    rows: readonly QueuedRow[],
    err: unknown,
  ) => {
    if (rows.length === 0) return;
    settle(sessionId, [], new Map([["failed", rows]]));
    deps.log.warn("queue start failed", {
      chat: sessionId,
      messages: rows.length,
      status: err instanceof HttpError ? err.status : 500,
    });
  };

  const startChat = (sessionId: string): Outcome => {
    const sorted = sort(sessionId);
    if (sorted === null || sorted.ready.length === 0) return "none";
    // a start that fails frees and wakes; only a lost claim asks again
    const before = again;
    let rows = sorted.ready;
    let err = launch(sessionId, rows);
    if (err !== null && !keeps(err)) {
      const found = culprits(sessionId, rows);
      fail(sessionId, found.failing, err);
      rows = found.pass;
      err = rows.length === 0 ? null : launch(sessionId, rows);
      if (err !== null && !keeps(err)) {
        fail(sessionId, rows, err);
        rows = [];
        err = null;
      }
    }
    if (!(err instanceof ClaimLost)) again = before;
    if (err === null) {
      if (rows.length === 0) return "none";
      deps.log.info("queue start", { chat: sessionId, messages: rows.length });
      return "started";
    }
    return processFull(err) ? "process" : "waits";
  };

  const pass = (): void => {
    const held = registry.values().map((send) => send.sessionId);
    // the page is bounded by the ceiling; a chat whose authors or
    // project are at their cap is passed over, a full process ends it
    for (const sessionId of queue.waitingChats(held, SENDS_CEILING)) {
      if (closed) return;
      if (registry.get(sessionId) !== null) continue;
      try {
        if (startChat(sessionId) === "process") return;
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

  // floorMs keeps a row that failed to expire from ringing at once
  const arm = (floorMs = 0): void => {
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
      arm(queue.oldestQueuedAt() === oldest ? MINUTE_MS : 0);
    };
    const ms = Math.max(oldest + minutes * MINUTE_MS - deps.clock(), floorMs);
    if (ms <= 0) {
      timer = setTimeout(ring, 0);
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
      wakeLater();
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
        wakeLater();
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
    const queued = queueMessage(deps, session, principal.userId, fields);
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
