// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An app with email on and its sender stopped, so a test says when an
// email goes out: the admin signed in, and a member with a real address
// whose links and codes a test asks for, sends and uses.

import { expect } from "bun:test";
import type { UserRow } from "../../src/server/users/index.ts";
import type { PutSmtpRequest } from "../../src/shared/api/smtp.ts";
import {
  collectLogs,
  ORIGIN,
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

export type EmailApp = {
  app: TestApp;
  admin: TestClient;
  maria: UserRow;
  logs: ReturnType<typeof collectLogs>;
  // every due row through the fake sender
  send(): Promise<number>;
  // the token in the newest email that carried one
  token(): string;
  // the code in the newest email that carried one
  code(): string;
  // the link page's answer to GET, or HEAD, of a token
  page(token: string, method?: "GET" | "HEAD"): Response;
  // whether the link page offers the token's Sign in button
  live(token: string): boolean;
  // asks as a browser: the client's jar keeps its challenge
  ask(client: TestClient, email?: string): Promise<Response>;
  // a code from the browser, for maria's address unless named
  sendCode(client: TestClient, code: string, email?: string): Promise<Response>;
  // the link page's form posted as a browser posts it from that page
  use(client: TestClient, token: string): Promise<Response>;
  // the outbox rows of a user, queued or not
  outbox(userId: string): { kind: string; status: string }[];
  // the user's links: whether a token was minted, and used
  links(userId: string): { purpose: string; minted: boolean; used: boolean }[];
};

export async function emailApp(
  options: {
    email?: boolean;
    unlistable?: (kind: string) => boolean;
    // more secrets, kept by reference so a test may change one
    secrets?: Record<string, string>;
  } = {},
): Promise<EmailApp> {
  const logs = collectLogs();
  const secrets = options.secrets ?? {};
  secrets["email-relay"] = "secret-pass";
  const app = await testApp({
    secrets,
    logFactory: logs.logFactory,
    unlistable: options.unlistable,
  });
  await app.email.stop();
  const admin = app.client();
  expect((await admin.signIn("admin")).status).toBe(200);
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
    code() {
      for (const { message } of [...app.emailSender.sent].reverse()) {
        const found = /code: (\d{6})$/.exec(message.subject);
        if (found !== null) return found[1]!;
      }
      throw new Error("no email carried a code");
    },
    page: (token, method = "GET") =>
      app.linkPage(new Request(`${ORIGIN}/link/${token}`, { method })),
    live: (token) =>
      app.linkPage(new Request(`${ORIGIN}/link/${token}`)).status === 200,
    ask: (client, email = "maria@example.test") =>
      client.call("POST", "/api/login/link", { body: { email } }),
    sendCode: (client, code, email = "maria@example.test") =>
      client.call("POST", "/api/login/code", { body: { email, code } }),
    use: (client, token) =>
      client.call("POST", `/api/links/${token}`, {
        form: {},
        origin: "null",
        headers: { "sec-fetch-site": "same-origin" },
      }),
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
