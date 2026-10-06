// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sender takes outbox rows one at a time, the scheduler's shape:
// started only when the app is activated, woken after a commit that
// queued email and on a timer from the clock, drained on stop. It reads
// the recipient again just before SMTP, so an email never reaches a user
// disabled or readdressed since the row was written.

import type { SmtpFailure } from "../../shared/contracts/smtp.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { type Clock, MINUTE_MS, sleep } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import {
  type DropWord,
  type EmailKind,
  hasControl,
  retryAt,
  STALE_CLAIM_MS,
} from "./rules.ts";
import type { Address, EmailSender, SendResult, SmtpServer } from "./smtp.ts";
import type { EmailStore, OutboxRow } from "./store.ts";

// a pass at least this often, so a stale claim is taken again; also
// the pause after a pass that threw, which no wake cuts short
const PASS_MS = MINUTE_MS;

// fromName in place of the server's, as an agent's "<agent> via 1ctx"
export type EmailContent = {
  subject: string;
  text: string;
  html?: string;
  fromName?: string;
};

// a kind's last word before SMTP: the text to send, built now (a link
// email mints its token here), or a word that drops the row
export type Prepare = (
  row: OutboxRow,
  user: UserRow,
) => EmailContent | DropWord;

export type SenderDeps = {
  clock: Clock;
  log: Log;
  store: EmailStore;
  emailSender: EmailSender;
  // the server and who email is from, null while email is off
  ready(): { server: SmtpServer; from: Address } | null;
  users: { byId(id: string): UserRow | null };
  prepare(kind: EmailKind): Prepare | undefined;
};

export type Sender = {
  start(): void;
  // no row is taken from here; resolves once the one in flight ended
  stop(): Promise<void>;
  // after a cut shutdown: the send in flight writes nothing, since the
  // db is closed; its claim goes stale and the row is sent again
  halt(): void;
  wake(): void;
  // rows until none is due; the count taken
  pass(live?: () => boolean): Promise<number>;
  dispose(): void;
};

// the text a row carries, for a kind with no prepare of its own
const stored = (row: OutboxRow): EmailContent | null =>
  row.subject === null || row.body === null
    ? null
    : { subject: row.subject, text: row.body };

export function sender(deps: SenderDeps): Sender {
  let running = false;
  let halted = false;
  let epoch = 0;
  let wakeWait: (() => void) | null = null;
  let haltWait: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let loop: Promise<void> = Promise.resolve();

  const wake = () => {
    const resolve = wakeWait;
    wakeWait = null;
    resolve?.();
  };

  const fields = (row: OutboxRow) => ({
    kind: row.kind,
    user: row.userId,
    outbox: row.id,
  });

  // the recipient as they are now, or why they are no longer one
  const recipient = (row: OutboxRow): UserRow | DropWord => {
    const user = deps.users.byId(row.userId);
    if (user === null) return "gone";
    if (user.disabled) return "disabled";
    if (user.emailPlaceholder) return "placeholder";
    return user;
  };

  const failed = (row: OutboxRow, failure: SmtpFailure) => {
    const now = deps.clock();
    const attempts = row.attempts + 1;
    const at = retryAt(attempts, now);
    if (at === null) deps.store.fail(row.id, attempts, failure, now);
    else deps.store.retry(row.id, attempts, at, now);
    deps.log.warn("email failed", {
      ...fields(row),
      failure,
      attempts,
      final: at === null,
    });
  };

  // a caller's bug: no later try fixes the text
  const broken = (row: OutboxRow) => {
    deps.store.fail(row.id, row.attempts + 1, "other", deps.clock());
    deps.log.warn("email failed", {
      ...fields(row),
      failure: "other",
      attempts: row.attempts + 1,
      final: true,
    });
  };

  const dropped = (row: OutboxRow, reason: DropWord) => {
    deps.store.remove(row.id);
    deps.log.info("email dropped", { ...fields(row), reason });
  };

  const deliver = async (
    row: OutboxRow,
    ready: { server: SmtpServer; from: Address },
  ): Promise<void> => {
    const user = recipient(row);
    if (typeof user === "string") return dropped(row, user);
    const prepare = deps.prepare(row.kind);
    let content: EmailContent | DropWord | null;
    try {
      content = prepare === undefined ? stored(row) : prepare(row, user);
    } catch (err) {
      deps.log.error("email prepare failed", {
        ...fields(row),
        ...errorFields(err),
      });
      failed(row, "other");
      return;
    }
    if (typeof content === "string") return dropped(row, content);
    if (
      content === null ||
      hasControl(content.subject) ||
      (content.fromName !== undefined && hasControl(content.fromName))
    ) {
      return broken(row);
    }
    let result: SendResult;
    try {
      result = await deps.emailSender(ready.server, {
        from: {
          name: content.fromName ?? ready.from.name,
          address: ready.from.address,
        },
        to: { name: user.fullName, address: user.email },
        subject: content.subject,
        text: content.text,
        ...(content.html === undefined ? {} : { html: content.html }),
        messageId: row.messageId,
      });
    } catch (err) {
      if (halted) return;
      deps.log.error("email send threw", {
        ...fields(row),
        ...errorFields(err),
      });
      result = "other";
    }
    if (halted) return;
    if (result !== "sent") {
      failed(row, result);
      return;
    }
    deps.store.sent(row.id, deps.clock());
    deps.log.info("email sent", fields(row));
  };

  const pass = async (live: () => boolean = () => true): Promise<number> => {
    let taken = 0;
    while (live()) {
      const ready = deps.ready();
      if (ready === null) break;
      const row = deps.store.claim(deps.clock(), STALE_CLAIM_MS);
      if (row === null) break;
      taken++;
      await deliver(row, ready);
    }
    return taken;
  };

  // a wake ends it only when wakeable; a stop always does
  const pause = async (ms: number, wakeable: boolean): Promise<void> => {
    const timer = sleep(deps.clock, ms);
    const ended = new Promise<void>((resolve) => {
      haltWait = resolve;
      if (wakeable) wakeWait = resolve;
    });
    await Promise.race([timer.promise, ended]);
    timer.cancel();
  };

  const wait = async (): Promise<void> => {
    const earliest = deps.ready() === null ? null : deps.store.earliest();
    const ms =
      earliest === null ? PASS_MS : Math.min(PASS_MS, earliest - deps.clock());
    if (ms > 0) await pause(ms, true);
  };

  // anything a pass or a wait throws (the db, a key file) is logged and
  // waited out, so the loop outlives it and never spins on it
  const run = async (mine: number) => {
    const live = () => running && epoch === mine;
    while (live()) {
      try {
        await pass(live);
        if (live()) await wait();
      } catch (err) {
        deps.log.error("email pass failed", errorFields(err));
        if (live()) await pause(PASS_MS, false);
      }
    }
  };

  const onBus = (event: BusEvent) => {
    if (event.type === "email.queued") wake();
  };

  return {
    start() {
      if (running) return;
      running = true;
      halted = false;
      unsubscribe ??= subscribe(onBus, deps.log);
      loop = run(++epoch);
    },
    stop() {
      running = false;
      wake();
      const halt = haltWait;
      haltWait = null;
      halt?.();
      return loop;
    },
    halt() {
      running = false;
      halted = true;
    },
    wake,
    pass,
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
