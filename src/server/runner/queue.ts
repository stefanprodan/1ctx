// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The queue dispatcher (docs/queue.md, The queue dispatcher).

import type {
  QueuedResponse,
  SendMessageRequest,
} from "../../shared/api/sessions.ts";
import type { NotSentReason } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { type Clock, MINUTE_MS } from "../lib/clock.ts";
import { HttpError } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  type PendingRow,
  type QueuedRow,
  queueChanged,
  type SessionRow,
  type SessionStore,
  type SummonAgents,
  type WaitingCursor,
} from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import { principalOf } from "./authors.ts";
import { pendingTurns } from "./channel-queue.ts";
import { chatFor } from "./chat-guard.ts";
import { queueMessage } from "./enqueue.ts";
import type { PreparedRun } from "./prepare.ts";
import {
  CapFull,
  LockHeld,
  type Registry,
  Restarting,
  RunCapacity,
} from "./registry.ts";
import { ClaimLost, type QueuedClaim } from "./start.ts";
import { summonGone, summons, turnBatch } from "./summon.ts";
import { claimsOf, messagesOf, type TurnMessage } from "./turn.ts";

// passes one wake may run before it hands the rest to a later turn
const PASSES_PER_WAKE = 4;
// the chats one expiry read takes
const EXPIRE_PAGE = 64;
// the queued rows one read of a pass takes
export const WAITING_PAGE = 64;

export type DispatcherDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  sessions: SessionStore;
  registry: Registry;
  limits: { current(): Limits };
  users: { byId(id: string): UserRow | null };
  agents: SummonAgents;
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
  preparePending(row: PendingRow): PreparedRun;
};

// what one chat's start came to; a full process ends the pass
type Outcome = "none" | "started" | "waits" | "process";

// the refusals that leave the rows queued for a later wake, by class
const keeps = (err: unknown): boolean =>
  err instanceof CapFull ||
  err instanceof RunCapacity ||
  err instanceof LockHeld ||
  err instanceof Restarting ||
  err instanceof ClaimLost;

const processFull = (err: unknown): boolean =>
  (err instanceof CapFull || err instanceof RunCapacity) &&
  err.cap === "process";

// a probe's own throw, which rolls its transaction back
const PROBED = new Error("probed");

export type Dispatcher = {
  readonly closed: boolean;
  changed(pendingId?: string): void;
  // expire what waited too long, start what can, set the timer
  start(): void;
  // no pass after this, from the drain's start: a row left queued stays
  // queued, and every message to a chat is queued for the next start
  close(): void;
  wake(): void;
  // the message queued when the chat's lock is held or the dispatcher
  // is closed, else null: the chat is free, its own queue tried first,
  // and the caller sends
  enqueue(
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): QueuedResponse | null;
};

export function dispatcher(deps: DispatcherDeps): Dispatcher {
  const { db, sessions, registry } = deps;
  const queue = sessions.queue;
  const pending = pendingTurns(deps);
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
      // the authors whose rows turned learn it on their own connections
      const authors = [...notSent.values()].flat().map((row) => row.authorId);
      const events =
        dropped > 0 || [...turned.values()].some((n) => n > 0)
          ? queueChanged(db, sessionId, { shared: true, authors })
          : [];
      return { result: { dropped, turned }, events };
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
  ): { session: SessionRow; ready: QueuedRow[]; agent: string } | null => {
    const rows = queue.waiting(sessionId);
    if (rows.length === 0) return null;
    const session = sessions.byId(sessionId);
    if (session === null) return null;
    const cutoff =
      deps.clock() - deps.limits.current().queuedMinutes * MINUTE_MS;
    const agent =
      session.agentId === null
        ? ""
        : (deps.agents.byId(session.agentId)?.name ?? "");
    const whole: NotSentReason | null =
      session.archived !== null
        ? session.archived.reason === "agent"
          ? "agent-deleted"
          : "archived"
        : agent === ""
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
        (summonGone(deps.agents, agent, row.text)
          ? "agent-deleted"
          : row.queuedAt <= cutoff
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
    return { session, ready, agent };
  };

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
    // a summon is a turn of its own: those before it start first
    let rows = turnBatch(sorted.ready, summons(sorted.agent));
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

  // every chat with queued rows, oldest wait first, in keyset pages: a
  // chat whose authors or project are at their cap is passed over, a
  // full process ends the pass, and each queued row is read once
  const pass = (): void => {
    const held = registry.values().map((send) => send.sessionId);
    const seen = new Set<string>();
    let after: WaitingCursor | null = null;
    for (;;) {
      const page = queue.waitingRows(held, after, WAITING_PAGE);
      for (const row of page) {
        if (closed) return;
        if (seen.has(row.sessionId)) continue;
        seen.add(row.sessionId);
        if (registry.hasSession(row.sessionId)) continue;
        try {
          if (startChat(row.sessionId) === "process") return;
        } catch (err) {
          deps.log.error("queue pass failed", {
            chat: row.sessionId,
            ...errorFields(err),
          });
        }
      }
      if (page.length < WAITING_PAGE) return;
      after = page.at(-1)!;
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
          if (!registry.hasSession(sessionId)) startChat(sessionId);
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
    const oldest = pending.oldest();
    if (oldest === null) return;
    const minutes = deps.limits.current().queuedMinutes;
    armedMinutes = minutes;
    const mine = token;
    const ring = () => {
      if (mine !== token || closed) return;
      armedMinutes = null;
      expire();
      pending.pass(true);
      arm(pending.oldest() === oldest ? MINUTE_MS : 0);
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

  const wake = (pendingId?: string): { error: unknown } | null => {
    if (!started || closed) return null;
    // a pass writes its own transactions, so never inside another
    if (db.inTransaction || dispatching) {
      if (db.inTransaction) wakeLater();
      else again = true;
      return null;
    }
    let refusal: { error: unknown } | null = null;
    dispatching = true;
    try {
      for (let i = 0; i < PASSES_PER_WAKE; i++) {
        again = false;
        pass();
        refusal = pending.pass(false, pendingId) ?? refusal;
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
    return refusal;
  };

  const enqueue = (
    principal: Principal,
    sessionId: string,
    fields: SendMessageRequest,
  ): QueuedResponse | null => {
    const session = chatFor(deps, principal, sessionId, "continue");
    // a queue a full cap left behind goes before the new message
    if (started && !closed && !registry.hasSession(session.id)) {
      startChat(session.id);
    }
    if (!closed && !registry.hasSession(session.id)) return null;
    const queued = queueMessage(deps, session, principal.userId, fields);
    if (started && !closed && armedMinutes === null) arm();
    return queued;
  };

  return {
    get closed() {
      return closed;
    },
    changed(pendingId) {
      const refusal = wake(pendingId);
      if (started && !closed) arm();
      if (refusal !== null) throw refusal.error;
    },
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
