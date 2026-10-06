// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Mail: the instance's one SMTP server, the outbox every mail goes
// through and the sender that empties it. Mail is off until an admin
// saves a server whose key file is present; every part that mails asks
// enabled() first. A caller writes its row with enqueue() inside its
// own transaction and returns the events, so the sender wakes only
// after the commit.

import type { MailResponse, MailTestResponse } from "../../shared/api/mail.ts";
import type { MailFailure, MailSettings } from "../../shared/contracts/mail.ts";
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
  FAILED_KEEP_MS,
  hasControl,
  linkOf,
  type MailKind,
  messageIdOf,
  SENT_KEEP_MS,
} from "./rules.ts";
import { type Prepare, sender } from "./sender.ts";
import type { Address, Mailer, SmtpServer } from "./smtp.ts";
import { MailStore } from "./store.ts";

export {
  pairProblem,
  parseFromAddress,
  parseFromName,
  parseHost,
  parseMailKeyName,
  parseMailUsername,
  parsePort,
  parsePublicAddress,
  parseSecurity,
} from "./parse.ts";
export {
  type DropWord,
  MAIL_KINDS,
  type MailKind,
  publicOrigin,
} from "./rules.ts";
export type { MailContent, Prepare } from "./sender.ts";
export {
  type Mailer,
  type Outgoing,
  type SendResult,
  type SmtpServer,
  smtpMailer,
} from "./smtp.ts";
export type { OutboxRow } from "./store.ts";
export { MailStore };

export const mailQueued: BusEvent = { type: "mail.queued", data: {} };

// what an agent's mail and an alert carry; a link mail's row holds no
// text, its prepare builds it when the row is sent
export type Enqueue = {
  kind: MailKind;
  userId: string;
  projectId?: string | null;
  sessionId?: string | null;
  subject?: string | null;
  body?: string | null;
};

// what the Monitor shows of mail, null until it is set up
export type MailAttention = {
  keyName: string | null;
  hasKey: boolean;
  queued: number;
  failed: number;
  lastFailure: MailFailure | null;
  lastFailedAt: number | null;
};

export type MailDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  // the email- key files: a value by name, and the names
  secret: (name: string) => string | null;
  keys: () => string[];
  users: { byId(id: string): UserRow | null };
  mailer: Mailer;
};

export type Mail = {
  store: MailStore;
  routes: RouteDescriptor[];
  enabled(): boolean;
  settings(): MailSettings | null;
  // a full address under the public address; throws while mail is off
  link(path: string): string;
  // writes a row in the caller's transaction; the events to return
  enqueue(fields: Enqueue): BusEvent[];
  // a kind's last word before SMTP; one per kind
  register(kind: MailKind, prepare: Prepare): void;
  start(): void;
  stop(): Promise<void>;
  dispose(): void;
  wake(): void;
  pass(): Promise<number>;
  // sent rows past their day, failed ones past their week; the count
  // removed
  sweep(now: number): number;
  attention(): MailAttention | null;
};

export function mailArea(deps: MailDeps): Mail {
  const store = new MailStore(deps.db);
  const prepares = new Map<MailKind, Prepare>();
  // a key file that cannot be read is a missing one: mail is off
  const secret = (name: string): string | null => {
    try {
      return deps.secret(name);
    } catch {
      return null;
    }
  };
  const hasKey = (settings: MailSettings) =>
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
    mailer: deps.mailer,
    ready,
    users: deps.users,
    prepare: (kind) => prepares.get(kind),
  });
  const response = (userId: string): MailResponse => {
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
  const test = async (userId: string): Promise<MailTestResponse> => {
    const on = ready();
    const settings = store.settings();
    if (on === null || settings === null) {
      throw new Conflict("mail is not set up");
    }
    const user = deps.users.byId(userId);
    if (user === null || user.emailPlaceholder) {
      throw new Conflict("your email is a placeholder");
    }
    const result = await deps.mailer(on.server, {
      from: on.from,
      to: { name: user.fullName, address: user.email },
      subject: "Test mail from 1ctx",
      text: `This is a test mail from 1ctx at ${settings.publicAddress}.\n\nMail is set up.\n`,
      messageId: messageIdOf(`test-${newId()}`, settings.fromAddress),
    });
    const fields = { kind: "test", user: user.id };
    if (result === "sent") deps.log.info("mail sent", fields);
    else deps.log.warn("mail failed", { ...fields, failure: result });
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
      if (settings === null) throw new Error("mail is not set up");
      return linkOf(settings.publicAddress, path);
    },
    enqueue(fields) {
      const settings = store.settings();
      if (settings === null || !enabled()) throw new Error("mail is off");
      if (fields.subject != null && hasControl(fields.subject)) {
        throw new Error("a mail's subject is one line");
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
      return [mailQueued];
    },
    register(kind, prepare) {
      if (prepares.has(kind)) throw new Error(`${kind} is registered`);
      prepares.set(kind, prepare);
    },
    start: () => loop.start(),
    stop: () => loop.stop(),
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
