// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The email routes through the composed app: the settings and when email
// is on, the key files offered, and Send test's words, sent now to the
// signed-in admin once their address is a real one.

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import type {
  SmtpResponse,
  SmtpTestResponse,
} from "../../../src/shared/api/smtp.ts";
import { SMTP_FAILURES } from "../../../src/shared/contracts/smtp.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";

const SERVER = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "noreply@example.test",
  fromName: "1ctx",
  publicAddress: "https://1ctx.example.test",
};

async function signedIn(secrets: Record<string, string> = {}) {
  const logs = collectLogs();
  const app = await testApp({
    secrets: { "email-relay": "secret-pass", ...secrets },
    logFactory: logs.logFactory,
  });
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const read = async () => {
    const res = await admin.call("GET", "/api/admin/smtp");
    expect(res.status).toBe(200);
    return (await res.json()) as SmtpResponse;
  };
  return { app, admin, read, logs };
}

describe("the email routes", () => {
  test("start off, list the email- keys and turn on when saved", async () => {
    const { app, admin, read } = await signedIn({ "mcp-other": "x" });
    expect(await read()).toEqual({
      settings: null,
      enabled: false,
      hasKey: false,
      keys: ["email-relay"],
      // the bootstrap admin's address is made up
      to: null,
    });
    expect(app.email.enabled()).toBe(false);
    const put = await admin.call("PUT", "/api/admin/smtp", { body: SERVER });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as SmtpResponse;
    expect(saved.settings).toEqual({ ...SERVER, updatedAt: app.now.value });
    expect(saved.enabled).toBe(true);
    expect(app.email.link("/chat/abc")).toBe(
      "https://1ctx.example.test/chat/abc",
    );
    // a value never crosses
    expect(JSON.stringify(saved)).not.toContain("secret-pass");
    await app.shutdown();
  });

  test("refuse a bad body with a 400 and keep what was held", async () => {
    const { app, admin, read } = await signedIn();
    for (const body of [
      { ...SERVER, publicAddress: "http://1ctx.example.test" },
      { ...SERVER, keyName: null },
      { ...SERVER, port: 70000 },
      { ...SERVER, fromName: "a\r\nb" },
    ]) {
      const res = await admin.call("PUT", "/api/admin/smtp", { body });
      expect(res.status).toBe(400);
    }
    expect((await read()).settings).toBeNull();
    await app.shutdown();
  });

  test("stay off while the named key file is missing", async () => {
    const { app, admin, read } = await signedIn();
    await admin.call("PUT", "/api/admin/smtp", {
      body: { ...SERVER, keyName: "email-gone" },
    });
    expect(await read()).toMatchObject({ enabled: false, hasKey: false });
    const res = await admin.call("POST", "/api/admin/smtp/test");
    expect(res.status).toBe(409);
    await app.shutdown();
  });

  test("send a test only to an admin with a real address", async () => {
    const { app, admin, read, logs } = await signedIn();
    await admin.call("PUT", "/api/admin/smtp", { body: SERVER });
    const refused = await admin.call("POST", "/api/admin/smtp/test");
    expect(refused.status).toBe(409);
    expect(app.emailSender.sent).toEqual([]);
    const me = app.users.byUsername("admin")!;
    expect(me.emailPlaceholder).toBe(true);
    const patched = await admin.call("PATCH", `/api/users/${me.id}`, {
      body: { email: "root@example.test" },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).user.emailPlaceholder).toBe(false);
    expect((await read()).to).toBe("root@example.test");
    for (const result of ["sent", ...SMTP_FAILURES] as const) {
      app.emailSender.result = result;
      const res = await admin.call("POST", "/api/admin/smtp/test");
      expect(res.status).toBe(200);
      expect((await res.json()) as SmtpTestResponse).toEqual({ result });
    }
    // straight to the server, never through the outbox
    expect(
      app.db.query("select count(*) as n from email_outbox").get(),
    ).toEqual({ n: 0 });
    expect(app.emailSender.sent[0]!.message).toMatchObject({
      from: { name: "1ctx", address: "noreply@example.test" },
      to: { address: "root@example.test" },
    });
    expect(app.emailSender.sent[0]!.server.password).toBe("secret-pass");
    const lines = logs.events.filter((e) => e.area === "email");
    expect(lines.map((e) => e.msg)).toEqual([
      "email sent",
      ...SMTP_FAILURES.map(() => "email failed"),
    ]);
    expect(JSON.stringify(lines)).not.toContain("example.test");
    await app.shutdown();
  });

  test("mark every address on the project's domain a placeholder", async () => {
    const { app, admin } = await signedIn();
    const made = await admin.call("POST", "/api/users", {
      body: {
        username: "maria",
        fullName: "Maria",
        email: "maria@1ctx.dev",
        role: "member",
        tz: "UTC",
        password: "maria-password",
      },
    });
    expect(made.status).toBe(201);
    const maria = (await made.json()).user;
    expect(maria.emailPlaceholder).toBe(true);
    const edit = async (email: string) => {
      const res = await admin.call("PATCH", `/api/users/${maria.id}`, {
        body: { email },
      });
      expect(res.status).toBe(200);
      return (await res.json()).user.emailPlaceholder;
    };
    expect(await edit("maria@example.test")).toBe(false);
    expect(await edit("maria@1ctx.dev")).toBe(true);
    // a subdomain is someone's inbox, the project's own domain is not
    expect(await edit("maria@team.1ctx.dev")).toBe(false);
    await app.shutdown();
  });

  test("say on the users list whether email is on", async () => {
    const { app, admin } = await signedIn();
    const emailOn = async () =>
      (await (await admin.call("GET", "/api/users")).json()).emailOn;
    expect(await emailOn()).toBe(false);
    await admin.call("PUT", "/api/admin/smtp", { body: SERVER });
    expect(await emailOn()).toBe(true);
    await app.shutdown();
  });

  test("never start the sender in an app that is not activated", async () => {
    const app = await testApp({
      activate: false,
      secrets: { "email-relay": "secret-pass" },
    });
    app.email.store.saveSettings(SERVER, app.now.value);
    const admin = app.users.byUsername("admin");
    expect(admin).toBeNull();
    const user = app.createUser({
      username: "ann",
      fullName: "Ann",
      email: "ann@example.test",
      role: "member",
      passwordHash: "x",
      mustChangePassword: false,
      now: app.now.value,
    });
    transact(app.db, () => ({
      result: undefined,
      events: app.email.enqueue({
        kind: "notice",
        userId: user.id,
        subject: "Hi",
        body: "x",
      }),
    }));
    app.now.value += 60 * 60_000;
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.emailSender.sent).toEqual([]);
    expect(app.email.store.counts().queued).toBe(1);
    await app.shutdown();
  });

  test("show on the Monitor a missing key file and the outbox", async () => {
    const { app, admin } = await signedIn();
    const attention = async () =>
      (await (await admin.call("GET", "/api/admin/attention")).json()) as {
        items: unknown[];
        email: unknown;
      };
    expect((await attention()).email).toBeNull();
    await admin.call("PUT", "/api/admin/smtp", {
      body: { ...SERVER, keyName: "email-gone" },
    });
    expect(await attention()).toEqual({
      items: [{ kind: "smtp-key", name: "email-gone", at: null }],
      email: { queued: 0, failed: 0 },
    });
    await app.shutdown();
  });
});
