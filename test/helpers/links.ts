// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An app with email on and its sender stopped, so a test says when an
// email goes out: the admin signed in, and a member with a real address
// whose links a test asks for, sends and uses.

import { expect } from "bun:test";
import type { UserRow } from "../../src/server/users/index.ts";
import type { PutSmtpRequest } from "../../src/shared/api/smtp.ts";
import {
  collectLogs,
  hashPassword,
  type TestApp,
  type TestClient,
  testApp,
} from "./app.ts";

export const SMTP: PutSmtpRequest = {
  host: "smtp.example.test",
  port: 465,
  security: "tls",
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "noreply@example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test",
};

export const MARIA_PASSWORD = "maria-first-pw";

export type EmailApp = {
  app: TestApp;
  admin: TestClient;
  maria: UserRow;
  logs: ReturnType<typeof collectLogs>;
  // every due row through the fake sender
  send(): Promise<number>;
  // the token in the newest email that carried one
  token(): string;
  // the outbox rows of a user, queued or not
  outbox(userId: string): { kind: string; status: string }[];
  // the user's links: whether a token was minted, and used
  links(userId: string): { purpose: string; minted: boolean; used: boolean }[];
};

export async function emailApp(
  options: { email?: boolean; mustChange?: boolean } = {},
): Promise<EmailApp> {
  const logs = collectLogs();
  const app = await testApp({
    secrets: { "email-relay": "secret-pass" },
    logFactory: logs.logFactory,
  });
  await app.email.stop();
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  if (options.email !== false) {
    const put = await admin.call("PUT", "/api/admin/smtp", { body: SMTP });
    expect(put.status).toBe(200);
  }
  const maria = app.createUser({
    username: "maria",
    fullName: "Maria Pop",
    email: "maria@example.test",
    role: "member",
    tz: "Europe/Bucharest",
    passwordHash: await hashPassword(MARIA_PASSWORD),
    mustChangePassword: options.mustChange ?? false,
    now: app.now.value,
  });
  return {
    app,
    admin,
    maria,
    logs,
    send: () => app.email.pass(),
    token() {
      for (const { message } of [...app.emailSender.sent].reverse()) {
        const found = /\/link\/([A-Za-z0-9_-]{43})/.exec(message.text);
        if (found !== null) return found[1]!;
      }
      throw new Error("no email carried a link");
    },
    outbox: (userId) =>
      app.db
        .query<{ kind: string; status: string }, [string]>(
          "select kind, status from email_outbox where user_id = ? order by created_at, rowid",
        )
        .all(userId),
    links: (userId) =>
      app.db
        .query<
          {
            purpose: string;
            token_hash: string | null;
            used_at: number | null;
          },
          [string]
        >(
          "select purpose, token_hash, used_at from user_links where user_id = ? order by created_at, rowid",
        )
        .all(userId)
        .map((row) => ({
          purpose: row.purpose,
          minted: row.token_hash !== null,
          used: row.used_at !== null,
        })),
  };
}
