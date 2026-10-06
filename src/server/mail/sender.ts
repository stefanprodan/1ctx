// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sender takes outbox rows one at a time, the scheduler's shape:
// started only when the app is activated, woken after a commit that
// queued mail and on a timer from the clock, drained on stop. It reads
// the recipient again just before SMTP, so a mail never reaches a user
// disabled or readdressed since the row was written.

import type { MailFailure } from "../../shared/contracts/mail.ts";
import { type BusEvent, subscribe } from "../lib/bus.ts";
import { type Clock, MINUTE_MS, sleep } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import {
  type DropWord,
  hasControl,
  type MailKind,
  retryAt,
  STALE_CLAIM_MS,
} from "./rules.ts";
import type { Address, Mailer, SendResult, SmtpServer } from "./smtp.ts";
import type { MailStore, OutboxRow } from "./store.ts";

// a pass at least this often, so a stale claim is taken again
const PASS_MS = MINUTE_MS;

export type MailContent = { subject: string; text: string; html?: string };

// a kind's last word before SMTP: the text to send, built now (a link
// mail mints its token here), or a word that drops the row
export type Prepare = (row: OutboxRow, user: UserRow) => MailContent | DropWord;

export type SenderDeps = {
  clock: Clock;
  log: Log;
  store: MailStore;
  mailer: Mailer;
  // the server and who mail is from, null while mail is off
  ready(): { server: SmtpServer; from: Address } | null;
  users: { byId(id: string): UserRow | null };
  prepare(kind: MailKind): Prepare | undefined;
};

export type Sender = {
  start(): void;
  // no row is taken from here; resolves once the one in flight ended
  stop(): Promise<void>;
  wake(): void;
  // rows until none is due; the count taken
  pass(live?: () => boolean): Promise<number>;
  dispose(): void;
};

// the text a row carries, for a kind with no prepare of its own
const stored = (row: OutboxRow): MailContent | null =>
  row.subject === null || row.body === null
    ? null
    : { subject: row.subject, text: row.body };

export function sender(deps: SenderDeps): Sender {
  let running = false;
  let epoch = 0;
  let wakeWait: (() => void) | null = null;
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
    mail: row.id,
  });

  // the recipient as they are now, or why they are no longer one
  const recipient = (row: OutboxRow): UserRow | DropWord => {
    const user = deps.users.byId(row.userId);
    if (user === null) return "gone";
    if (user.disabled) return "disabled";
    if (user.emailPlaceholder) return "placeholder";
    return user;
  };

  const failed = (row: OutboxRow, failure: MailFailure) => {
    const now = deps.clock();
    const attempts = row.attempts + 1;
    const at = retryAt(attempts, now);
    if (at === null) deps.store.fail(row.id, attempts, failure, now);
    else deps.store.retry(row.id, attempts, at, now);
    deps.log.warn("mail failed", {
      ...fields(row),
      failure,
      attempts,
      final: at === null,
    });
  };

  // a caller's bug: no later try fixes the text
  const broken = (row: OutboxRow) => {
    deps.store.fail(row.id, row.attempts + 1, "other", deps.clock());
    deps.log.warn("mail failed", {
      ...fields(row),
      failure: "other",
      attempts: row.attempts + 1,
      final: true,
    });
  };

  const dropped = (row: OutboxRow, reason: DropWord) => {
    deps.store.remove(row.id);
    deps.log.info("mail dropped", { ...fields(row), reason });
  };

  const deliver = async (
    row: OutboxRow,
    ready: { server: SmtpServer; from: Address },
  ): Promise<void> => {
    const user = recipient(row);
    if (typeof user === "string") return dropped(row, user);
    const prepare = deps.prepare(row.kind);
    let content: MailContent | DropWord | null;
    try {
      content = prepare === undefined ? stored(row) : prepare(row, user);
    } catch (err) {
      deps.log.error("mail prepare failed", {
        ...fields(row),
        ...errorFields(err),
      });
      failed(row, "other");
      return;
    }
    if (typeof content === "string") return dropped(row, content);
    if (content === null || hasControl(content.subject)) return broken(row);
    let result: SendResult;
    try {
      result = await deps.mailer(ready.server, {
        from: ready.from,
        to: { name: user.fullName, address: user.email },
        subject: content.subject,
        text: content.text,
        ...(content.html === undefined ? {} : { html: content.html }),
        messageId: row.messageId,
      });
    } catch (err) {
      deps.log.error("mail send threw", {
        ...fields(row),
        ...errorFields(err),
      });
      result = "other";
    }
    if (result !== "sent") {
      failed(row, result);
      return;
    }
    deps.store.remove(row.id);
    deps.log.info("mail sent", fields(row));
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

  const wait = async (): Promise<void> => {
    const earliest = deps.ready() === null ? null : deps.store.earliest();
    const ms =
      earliest === null ? PASS_MS : Math.min(PASS_MS, earliest - deps.clock());
    if (ms <= 0) return;
    const timer = sleep(deps.clock, ms);
    const waking = new Promise<void>((resolve) => {
      wakeWait = resolve;
    });
    await Promise.race([timer.promise, waking]);
    timer.cancel();
  };

  const run = async (mine: number) => {
    const live = () => running && epoch === mine;
    while (live()) {
      try {
        await pass(live);
      } catch (err) {
        deps.log.error("mail pass failed", errorFields(err));
      }
      if (live()) await wait();
    }
  };

  const onBus = (event: BusEvent) => {
    if (event.type === "mail.queued") wake();
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe ??= subscribe(onBus, deps.log);
      loop = run(++epoch);
    },
    stop() {
      running = false;
      wake();
      return loop;
    },
    wake,
    pass,
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
