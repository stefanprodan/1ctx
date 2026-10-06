// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Asking for a link and using it, through the composed app with the
// fake email sender and the fake clock: an ask answers the same for
// every account and does its work after the answer, the token is minted
// when the email is sent, and a link is used once.

import { describe, expect, test } from "bun:test";
import { emailApp, MARIA_PASSWORD } from "../../helpers/links.ts";

const MINUTE = 60_000;

// what an answer shows a caller: the status, the body and the headers
// that could differ
async function shown(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    cookie: res.headers.get("set-cookie"),
    type: res.headers.get("content-type"),
  };
}

describe("asking for a link", () => {
  test("answers 202 with no body for any account, before any lookup", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const off = app.createUser({
      username: "gone",
      fullName: "Gone",
      email: "gone@example.test",
      role: "member",
      passwordHash: "x",
      mustChangePassword: false,
      disabled: true,
      now: app.now.value,
    });
    const seeded = app.createUser({
      username: "seeded",
      fullName: "Seeded",
      email: "seeded@1ctx.dev",
      role: "member",
      passwordHash: "x",
      mustChangePassword: false,
      now: app.now.value,
    });
    for (const path of ["/api/login/forgot", "/api/login/link"]) {
      const answers = [];
      for (const username of [
        "maria",
        "nobody",
        "gone",
        "seeded",
        "MARIA@example.test",
        "nobody@example.test",
      ]) {
        // one address each, under the login limit
        const res = await app
          .client(`10.0.1.${answers.length}`)
          .call("POST", path, {
            body: { username },
          });
        answers.push(await shown(res));
        // the lookup runs after the answer
        if (username === "maria") {
          expect(e.outbox(maria.id).map((row) => row.kind)).toEqual(
            path === "/api/login/forgot" ? [] : ["reset"],
          );
        }
      }
      for (const answer of answers) {
        expect(answer).toEqual({
          status: 202,
          body: "",
          cookie: null,
          type: null,
        });
      }
      await app.linkAsks();
    }
    // maria's address, by name and by email: one link each, the second
    // ask limited while the first is live
    expect(e.outbox(maria.id)).toEqual([
      { kind: "reset", status: "queued" },
      { kind: "signin", status: "queued" },
    ]);
    expect(e.outbox(off.id)).toEqual([]);
    expect(e.outbox(seeded.id)).toEqual([]);
    // the row holds no token and no text, the link no hash yet
    const row = app.db
      .query<{ subject: string | null; body: string | null }, [string]>(
        "select subject, body from email_outbox where user_id = ?",
      )
      .all(maria.id);
    expect(row).toEqual([
      { subject: null, body: null },
      { subject: null, body: null },
    ]);
    expect(e.links(maria.id)).toEqual([
      { purpose: "reset", minted: false, used: false },
      { purpose: "signin", minted: false, used: false },
    ]);
    // the issue is logged by username, never what was typed
    const issued = e.logs.events.filter((ev) => ev.msg === "link issued");
    expect(issued.map((ev) => ev.fields)).toEqual([
      { user: "maria", purpose: "reset" },
      { user: "maria", purpose: "signin" },
    ]);
    expect(JSON.stringify(e.logs.events)).not.toContain("nobody@example.test");
    await app.shutdown();
  });

  test("a limited account asks again once its link expired", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const ask = () =>
      app.client().call("POST", "/api/login/forgot", {
        body: { username: "maria" },
      });
    expect((await ask()).status).toBe(202);
    await app.linkAsks();
    await e.send();
    const first = e.token();
    expect((await ask()).status).toBe(202);
    await app.linkAsks();
    expect(e.outbox(maria.id)).toEqual([{ kind: "reset", status: "sent" }]);
    app.now.value += 31 * MINUTE;
    expect((await ask()).status).toBe(202);
    await app.linkAsks();
    await e.send();
    expect(e.token()).not.toBe(first);
    await app.shutdown();
  });

  test("only the per-address login limit answers 429", async () => {
    const e = await emailApp();
    const client = e.app.client("10.0.0.9");
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await client.call("POST", "/api/login/link", {
        body: { username: `user${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([...Array(10).fill(202), 429]);
    // the same window as a login
    expect((await client.login("maria", MARIA_PASSWORD)).status).toBe(429);
    await e.app.shutdown();
  });

  test("refuses a bad body with a 400", async () => {
    const e = await emailApp();
    for (const body of [{}, { username: "" }, { username: "a".repeat(255) }]) {
      const res = await e.app.client().call("POST", "/api/login/forgot", {
        body,
      });
      expect(res.status).toBe(400);
    }
    await e.app.shutdown();
  });

  test("is not there while email is off", async () => {
    const e = await emailApp({ email: false });
    for (const path of ["/api/login/forgot", "/api/login/link"]) {
      const res = await e.app.client().call("POST", path, {
        body: { username: "maria" },
      });
      expect(res.status).toBe(404);
    }
    await e.app.linkAsks();
    expect(e.outbox(e.maria.id)).toEqual([]);
    const me = await (await e.app.client().call("GET", "/api/me")).json();
    expect(me.emailOn).toBe(false);
    await e.app.shutdown();
  });
});

describe("a link email", () => {
  test("mints its token at the send, and the expiry counts from then", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    await app.client().call("POST", "/api/login/forgot", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    // queued for most of the link's life before it goes out
    app.now.value += 25 * MINUTE;
    expect(await e.send()).toBe(1);
    expect(e.links(maria.id)).toEqual([
      { purpose: "reset", minted: true, used: false },
    ]);
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.to).toEqual({
      name: "Maria Pop",
      address: "maria@example.test",
    });
    expect(message.subject).toBe("Reset your 1ctx password");
    const token = e.token();
    expect(message.text).toContain(`https://1ctx.example.test/link/${token}`);
    expect(message.html).toContain(
      `<a href="https://1ctx.example.test/link/${token}">`,
    );
    expect(message.text).not.toMatch(/[—;]/);
    app.now.value += 29 * MINUTE;
    expect(await e.read(token)).not.toBeNull();
    app.now.value += MINUTE;
    expect(await e.read(token)).toBeNull();
    await app.shutdown();
  });

  test("a retry carries a fresh token, a new Message-ID, and the old is dead", async () => {
    const e = await emailApp();
    const { app } = e;
    await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    app.emailSender.result = "timeout";
    await e.send();
    const failed = e.token();
    app.emailSender.result = "sent";
    app.now.value += MINUTE;
    await e.send();
    const sent = e.token();
    expect(sent).not.toBe(failed);
    // a client that kept the first copy must not drop this one
    const [first, second] = app.emailSender.sent.map(
      (s) => s.message.messageId,
    );
    expect(second).not.toBe(first);
    expect(await e.read(failed)).toBeNull();
    expect(await e.read(sent)).not.toBeNull();
    await app.shutdown();
  });
});

describe("using a link", () => {
  async function sentLink(
    purpose: "forgot" | "link",
    options: { mustChange?: boolean } = {},
  ) {
    const e = await emailApp(options);
    await e.app.client().call("POST", `/api/login/${purpose}`, {
      body: { username: "maria" },
    });
    await e.app.linkAsks();
    await e.send();
    return { ...e, link: `/api/links/${e.token()}` };
  }

  test("GET has no side effect and is never stored; a dead link is null", async () => {
    const e = await sentLink("forgot");
    for (let i = 0; i < 2; i++) {
      const res = await e.app.client().call("GET", e.link);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({
        link: { purpose: "reset", username: "maria" },
      });
    }
    expect(e.links(e.maria.id)).toEqual([
      { purpose: "reset", minted: true, used: false },
    ]);
    // a malformed token and an unknown one read the same
    for (const path of ["/api/links/nope", `/api/links/${"A".repeat(43)}`]) {
      const res = await e.app.client().call("GET", path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ link: null });
    }
    await e.app.shutdown();
  });

  test("a reset sets the password, signs out everywhere and opens one login", async () => {
    const e = await sentLink("forgot", { mustChange: true });
    const { app, maria } = e;
    const elsewhere = app.client();
    expect((await elsewhere.login("maria", MARIA_PASSWORD)).status).toBe(200);
    const tab = app.client();
    // a password is what a reset is for
    expect((await tab.call("POST", e.link, { body: {} })).status).toBe(400);
    expect(
      (await tab.call("POST", e.link, { body: { password: "short" } })).status,
    ).toBe(400);
    const res = await tab.call("POST", e.link, {
      body: { password: "maria-new-pw" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({
      username: "maria",
      mustChangePassword: false,
    });
    expect(tab.cookie).not.toBeNull();
    expect(
      (await (await tab.call("GET", "/api/me")).json()).user.username,
    ).toBe("maria");
    expect((await (await elsewhere.call("GET", "/api/me")).json()).user).toBe(
      null,
    );
    expect(app.users.byId(maria.id)!.mustChangePassword).toBe(false);
    expect((await app.client().login("maria", MARIA_PASSWORD)).status).toBe(
      401,
    );
    expect((await app.client().login("maria", "maria-new-pw")).status).toBe(
      200,
    );
    // used once
    const again = await app.client().call("POST", e.link, {
      body: { password: "maria-other-pw" },
    });
    expect(again.status).toBe(404);
    expect(await e.read(e.token())).toBeNull();
    expect(e.logs.events.some((ev) => ev.msg === "link used")).toBe(true);
    await app.shutdown();
  });

  test("a sign in link opens a login and sets no password", async () => {
    const e = await sentLink("link");
    const { app } = e;
    const tab = app.client();
    expect(
      (await tab.call("POST", e.link, { body: { password: "maria-new-pw" } }))
        .status,
    ).toBe(400);
    const res = await tab.call("POST", e.link, { body: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ username: "maria" });
    // the old password still works: nothing was reset
    expect((await app.client().login("maria", MARIA_PASSWORD)).status).toBe(
      200,
    );
    expect((await tab.call("POST", e.link, { body: {} })).status).toBe(404);
    await app.shutdown();
  });

  test("a must-change user who asks to sign in gets a reset link", async () => {
    const e = await sentLink("link", { mustChange: true });
    const { app, maria } = e;
    expect(e.links(maria.id)).toEqual([
      { purpose: "reset", minted: true, used: false },
    ]);
    expect(app.emailSender.sent.at(-1)!.message.subject).toBe(
      "Reset your 1ctx password",
    );
    expect(await e.read(e.token())).toEqual({
      purpose: "reset",
      username: "maria",
    });
    const res = await app.client().call("POST", e.link, {
      body: { password: "maria-new-pw" },
    });
    expect((await res.json()).user.mustChangePassword).toBe(false);
    await app.shutdown();
  });

  test("an expired link and a disabled user's link do nothing", async () => {
    const expired = await sentLink("link");
    expired.app.now.value += 15 * MINUTE;
    expect(await expired.read(expired.token())).toBeNull();
    const res = await expired.app.client().call("POST", expired.link, {
      body: {},
    });
    expect(res.status).toBe(404);
    expect(expired.app.client().cookie).toBeNull();
    await expired.app.shutdown();

    const disabled = await sentLink("link");
    expect(
      (
        await disabled.admin.call("PATCH", `/api/users/${disabled.maria.id}`, {
          body: { disabled: true },
        })
      ).status,
    ).toBe(200);
    expect(await disabled.read(disabled.token())).toBeNull();
    const tab = disabled.app.client();
    expect((await tab.call("POST", disabled.link, { body: {} })).status).toBe(
      404,
    );
    expect(tab.cookie).toBeNull();
    await disabled.app.shutdown();
  });

  test("two uses racing: one wins", async () => {
    const e = await sentLink("forgot");
    const [a, b] = await Promise.all([
      e.app
        .client()
        .call("POST", e.link, { body: { password: "first-new-pw" } }),
      e.app
        .client()
        .call("POST", e.link, { body: { password: "second-new-pw" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    await e.app.shutdown();
  });

  test("a tab signed in as another account is replaced", async () => {
    const e = await sentLink("link");
    const { app, admin } = e;
    const before = admin.cookie;
    const res = await admin.call("POST", e.link, { body: {} });
    expect(res.status).toBe(200);
    expect(admin.cookie).not.toBe(before);
    expect(
      (await (await admin.call("GET", "/api/me")).json()).user.username,
    ).toBe("maria");
    // the admin's login in this tab ended, it is not kept beside
    const old = app.client();
    old.cookie = before;
    expect((await (await old.call("GET", "/api/me")).json()).user).toBeNull();
    await app.shutdown();
  });

  test("uses the login limit", async () => {
    const e = await sentLink("link");
    const client = e.app.client("10.0.0.7");
    for (let i = 0; i < 10; i++) await client.login("nobody", "wrong");
    expect((await client.call("POST", e.link, { body: {} })).status).toBe(429);
    await e.app.shutdown();
  });
});

describe("login by email", () => {
  test("takes an email in any case, with the same 401 for a wrong one", async () => {
    const e = await emailApp({ email: false });
    const ok = await e.app.client().login("Maria@Example.TEST", MARIA_PASSWORD);
    expect(ok.status).toBe(200);
    const wrong = await e.app.client().login("maria@example.test", "nope");
    const unknown = await e.app.client().login("who@example.test", "nope");
    const byName = await e.app.client().login("who", "nope");
    const bodies = await Promise.all(
      [wrong, unknown, byName].map(async (r) => [r.status, await r.text()]),
    );
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]![0]).toBe(401);
    await e.app.shutdown();
  });
});
