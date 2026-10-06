// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mail routes through the composed app: the settings and when mail
// is on, the key files offered, and Send test's words, sent now to the
// signed-in admin once their address is a real one.

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import type {
  MailResponse,
  MailTestResponse,
} from "../../../src/shared/api/mail.ts";
import { MAIL_FAILURES } from "../../../src/shared/contracts/mail.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";

const SERVER = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  username: "api_token",
  keyName: "email-relay",
  fromAddress: "mail@example.test",
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
    const res = await admin.call("GET", "/api/admin/mail");
    expect(res.status).toBe(200);
    return (await res.json()) as MailResponse;
  };
  return { app, admin, read, logs };
}

describe("the mail routes", () => {
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
    expect(app.mail.enabled()).toBe(false);
    const put = await admin.call("PUT", "/api/admin/mail", { body: SERVER });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as MailResponse;
    expect(saved.settings).toEqual({ ...SERVER, updatedAt: app.now.value });
    expect(saved.enabled).toBe(true);
    expect(app.mail.link("/chat/abc")).toBe(
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
      const res = await admin.call("PUT", "/api/admin/mail", { body });
      expect(res.status).toBe(400);
    }
    expect((await read()).settings).toBeNull();
    await app.shutdown();
  });

  test("stay off while the named key file is missing", async () => {
    const { app, admin, read } = await signedIn();
    await admin.call("PUT", "/api/admin/mail", {
      body: { ...SERVER, keyName: "email-gone" },
    });
    expect(await read()).toMatchObject({ enabled: false, hasKey: false });
    const res = await admin.call("POST", "/api/admin/mail/test");
    expect(res.status).toBe(409);
    await app.shutdown();
  });

  test("send a test only to an admin with a real address", async () => {
    const { app, admin, read, logs } = await signedIn();
    await admin.call("PUT", "/api/admin/mail", { body: SERVER });
    const refused = await admin.call("POST", "/api/admin/mail/test");
    expect(refused.status).toBe(409);
    expect(app.mailer.sent).toEqual([]);
    const me = app.users.byUsername("admin")!;
    expect(me.emailPlaceholder).toBe(true);
    const patched = await admin.call("PATCH", `/api/users/${me.id}`, {
      body: { email: "root@example.test" },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).user.emailPlaceholder).toBe(false);
    expect((await read()).to).toBe("root@example.test");
    for (const result of ["sent", ...MAIL_FAILURES] as const) {
      app.mailer.result = result;
      const res = await admin.call("POST", "/api/admin/mail/test");
      expect(res.status).toBe(200);
      expect((await res.json()) as MailTestResponse).toEqual({ result });
    }
    // straight to the server, never through the outbox
    expect(app.db.query("select count(*) as n from mail_outbox").get()).toEqual(
      { n: 0 },
    );
    expect(app.mailer.sent[0]!.mail).toMatchObject({
      from: { name: "1ctx", address: "mail@example.test" },
      to: { address: "root@example.test" },
    });
    expect(app.mailer.sent[0]!.server.password).toBe("secret-pass");
    const lines = logs.events.filter((e) => e.area === "mail");
    expect(lines.map((e) => e.msg)).toEqual([
      "mail sent",
      ...MAIL_FAILURES.map(() => "mail failed"),
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
    // a subdomain is someone's mailbox, the project's own domain is not
    expect(await edit("maria@mail.1ctx.dev")).toBe(false);
    await app.shutdown();
  });

  test("say on the users list whether mail is on", async () => {
    const { app, admin } = await signedIn();
    const mailOn = async () =>
      (await (await admin.call("GET", "/api/users")).json()).mailOn;
    expect(await mailOn()).toBe(false);
    await admin.call("PUT", "/api/admin/mail", { body: SERVER });
    expect(await mailOn()).toBe(true);
    await app.shutdown();
  });

  test("never start the sender in an app that is not activated", async () => {
    const app = await testApp({
      activate: false,
      secrets: { "email-relay": "secret-pass" },
    });
    app.mail.store.saveSettings(SERVER, app.now.value);
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
      events: app.mail.enqueue({
        kind: "notice",
        userId: user.id,
        subject: "Hi",
        body: "x",
      }),
    }));
    app.now.value += 60 * 60_000;
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.mailer.sent).toEqual([]);
    expect(app.mail.store.counts().queued).toBe(1);
    await app.shutdown();
  });

  test("show on the Monitor a missing key file and the outbox", async () => {
    const { app, admin } = await signedIn();
    const attention = async () =>
      (await (await admin.call("GET", "/api/admin/attention")).json()) as {
        items: unknown[];
        mail: unknown;
      };
    expect((await attention()).mail).toBeNull();
    await admin.call("PUT", "/api/admin/mail", {
      body: { ...SERVER, keyName: "email-gone" },
    });
    expect(await attention()).toEqual({
      items: [{ kind: "mail-key", name: "email-gone", at: null }],
      mail: { queued: 0, failed: 0 },
    });
    await app.shutdown();
  });
});
