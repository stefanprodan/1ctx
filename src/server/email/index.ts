// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Email: the instance's one SMTP server, the outbox every email goes
// through and the sender that empties it. Email is off until an admin
// saves a server whose key file is present; every part that emails asks
// enabled() first. A caller writes its row with enqueue() inside its
// own transaction and returns the events, so the sender wakes only
// after the commit.

import type { SmtpResponse, SmtpTestResponse } from "../../shared/api/smtp.ts";
import type { SmtpFailure, SmtpSettings } from "../../shared/contracts/smtp.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { UserRow } from "../users/index.ts";
import { routes } from "./routes.ts";
import {
  type EmailKind,
  FAILED_KEEP_MS,
  hasControl,
  linkOf,
  messageIdOf,
  SENT_KEEP_MS,
} from "./rules.ts";
import { type Prepare, sender } from "./sender.ts";
import type { Address, EmailSender, SmtpServer } from "./smtp.ts";
import { EmailStore } from "./store.ts";

export {
  pairProblem,
  parseFromAddress,
  parseFromName,
  parseHost,
  parsePort,
  parsePublicAddress,
  parseSecurity,
  parseSmtpKeyName,
  parseSmtpUsername,
} from "./parse.ts";
export {
  type DropWord,
  EMAIL_KINDS,
  type EmailKind,
  publicOrigin,
} from "./rules.ts";
export type { EmailContent, Prepare } from "./sender.ts";
export {
  type EmailSender,
  type Outgoing,
  type SendResult,
  type SmtpServer,
  smtpSender,
} from "./smtp.ts";
export type { OutboxRow } from "./store.ts";
export { EmailStore };

export const emailQueued: BusEvent = { type: "email.queued", data: {} };

// what an agent's email and an alert carry; a link email's row holds no
// text, its prepare builds it when the row is sent
export type Enqueue = {
  kind: EmailKind;
  userId: string;
  projectId?: string | null;
  sessionId?: string | null;
  subject?: string | null;
  body?: string | null;
};

// what the Monitor shows of email, null until it is set up
export type EmailAttention = {
  keyName: string | null;
  hasKey: boolean;
  queued: number;
  failed: number;
  lastFailure: SmtpFailure | null;
  lastFailedAt: number | null;
};

export type EmailDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the email- key files: a value by name, and the names
  secret: (name: string) => string | null;
  keys: () => string[];
  users: { byId(id: string): UserRow | null };
  emailSender: EmailSender;
};

export type Email = {
  store: EmailStore;
  routes: RouteDescriptor[];
  enabled(): boolean;
  settings(): SmtpSettings | null;
  // a full address under the public address; throws while email is off
  link(path: string): string;
  // writes a row in the caller's transaction; the events to return
  enqueue(fields: Enqueue): BusEvent[];
  // a kind's last word before SMTP; one per kind
  register(kind: EmailKind, prepare: Prepare): void;
  // the user's queued rows of these kinds, in the caller's transaction;
  // the count removed
  dropQueued(userId: string, kinds: readonly EmailKind[]): number;
  start(): void;
  stop(): Promise<void>;
  // after a cut shutdown, so the send in flight writes nothing
  halt(): void;
  dispose(): void;
  wake(): void;
  pass(): Promise<number>;
  // sent rows past their day, failed ones past their week; the count
  // removed
  sweep(now: number): number;
  attention(): EmailAttention | null;
};

export function emailArea(deps: EmailDeps): Email {
  const store = new EmailStore(deps.db);
  const prepares = new Map<EmailKind, Prepare>();
  // a key file that cannot be read is a missing one: email is off
  const secret = (name: string): string | null => {
    try {
      return deps.secret(name);
    } catch {
      return null;
    }
  };
  const hasKey = (settings: SmtpSettings) =>
    settings.keyName === null || secret(settings.keyName) !== null;
  const ready = (): { server: SmtpServer; from: Address } | null => {
    const s = store.settings();
    if (s === null) return null;
    const password = s.keyName === null ? null : secret(s.keyName);
    if (s.keyName !== null && password === null) return null;
    return {
      server: {
        host: s.host,
        port: s.port,
        security: s.security,
        username: s.username,
        password,
      },
      from: { name: s.fromName, address: s.fromAddress },
    };
  };
  const enabled = () => ready() !== null;
  const loop = sender({
    clock: deps.clock,
    log: deps.log,
    store,
    emailSender: deps.emailSender,
    ready,
    users: deps.users,
    prepare: (kind) => prepares.get(kind),
  });
  const response = (userId: string): SmtpResponse => {
    const settings = store.settings();
    const user = deps.users.byId(userId);
    return {
      settings,
      enabled: enabled(),
      hasKey: settings !== null && hasKey(settings),
      keys: deps.keys(),
      to: user === null || user.emailPlaceholder ? null : user.email,
    };
  };
  // now, to the admin who asked, never through the outbox
  const test = async (userId: string): Promise<SmtpTestResponse> => {
    const on = ready();
    const settings = store.settings();
    if (on === null || settings === null) {
      throw new Conflict("email is not set up");
    }
    const user = deps.users.byId(userId);
    if (user === null || user.emailPlaceholder) {
      throw new Conflict("your email is a placeholder");
    }
    const result = await deps.emailSender(on.server, {
      from: on.from,
      to: { name: user.fullName, address: user.email },
      subject: "Test email from 1ctx",
      text: `This is a test email from 1ctx at ${settings.publicAddress}.\n\nEmail is set up.\n`,
      messageId: messageIdOf(`test-${newId()}`, settings.fromAddress),
    });
    const fields = { kind: "test", user: user.id };
    if (result === "sent") deps.log.info("email sent", fields);
    else deps.log.warn("email failed", { ...fields, failure: result });
    return { result };
  };
  return {
    store,
    routes: routes({
      response: (principal) => response(principal.userId),
      save: (fields) => {
        store.saveSettings(fields, deps.clock());
        // a saved server may send what waited for one
        loop.wake();
      },
      test: (principal) => test(principal.userId),
    }),
    enabled,
    settings: () => store.settings(),
    link(path) {
      const settings = store.settings();
      if (settings === null || !hasKey(settings)) {
        throw new Error("email is off");
      }
      return linkOf(settings.publicAddress, path);
    },
    enqueue(fields) {
      const settings = store.settings();
      if (settings === null || !enabled()) throw new Error("email is off");
      if (fields.subject != null && hasControl(fields.subject)) {
        throw new Error("an email's subject is one line");
      }
      const id = newId();
      const now = deps.clock();
      store.insert({
        id,
        kind: fields.kind,
        userId: fields.userId,
        projectId: fields.projectId ?? null,
        sessionId: fields.sessionId ?? null,
        subject: fields.subject ?? null,
        body: fields.body ?? null,
        messageId: messageIdOf(id, settings.fromAddress),
        createdAt: now,
        now,
      });
      return [emailQueued];
    },
    register(kind, prepare) {
      if (prepares.has(kind)) throw new Error(`${kind} is registered`);
      prepares.set(kind, prepare);
    },
    dropQueued: (userId, kinds) => store.dropQueued(userId, kinds),
    start: () => loop.start(),
    stop: () => loop.stop(),
    halt: () => loop.halt(),
    dispose: () => loop.dispose(),
    wake: () => loop.wake(),
    pass: () => loop.pass(),
    sweep: (now) => store.sweep(now - SENT_KEEP_MS, now - FAILED_KEEP_MS),
    attention() {
      const settings = store.settings();
      if (settings === null) return null;
      return {
        keyName: settings.keyName,
        hasKey: hasKey(settings),
        ...store.counts(),
      };
    },
  };
}
