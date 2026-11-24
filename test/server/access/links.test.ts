// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Asking for a link and using it, through the composed app with the
// fake email sender and the fake clock: an ask answers the same for
// every account and does its work after the answer, the token is minted
// when the email is sent, and a link is used once.

import { describe, expect, test } from "bun:test";
import {
  ASKED_LINKS_PER_HOUR,
  ASKED_LINKS_PER_USER_DAY,
} from "../../../src/server/email/index.ts";
import { DAY_MS, HOUR_MS } from "../../../src/server/lib/clock.ts";
import { ADMIN_KEY } from "../../helpers/app.ts";
import { emailApp, SMTP } from "../../helpers/links.ts";

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
      disabled: true,
      now: app.now.value,
    });
    const seeded = app.createUser({
      username: "seeded",
      fullName: "Seeded",
      email: "seeded@1ctx.dev",
      role: "member",
      now: app.now.value,
    });
    for (const path of ["/api/login/link"]) {
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
          expect(e.outbox(maria.id)).toEqual([]);
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
    // maria's address, by name and by email: one link, the second ask
    // limited while the first is live
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "queued" }]);
    expect(e.outbox(off.id)).toEqual([]);
    expect(e.outbox(seeded.id)).toEqual([]);
    // the row holds no token and no text, the link no hash yet
    const row = app.db
      .query<{ subject: string | null; body: string | null }, [string]>(
        "select subject, body from email_outbox where user_id = ?",
      )
      .all(maria.id);
    expect(row).toEqual([{ subject: null, body: null }]);
    expect(e.links(maria.id)).toEqual([
      { purpose: "signin", minted: false, used: false },
    ]);
    // the issue is logged by username, never what was typed
    const issued = e.logs.events.filter((ev) => ev.msg === "link issued");
    expect(issued.map((ev) => ev.fields)).toEqual([
      { user: "maria", purpose: "signin" },
    ]);
    expect(JSON.stringify(e.logs.events)).not.toContain("nobody@example.test");
    await app.shutdown();
  });

  test("a limited account asks again once its link expired", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const ask = () =>
      app.client().call("POST", "/api/login/link", {
        body: { username: "maria" },
      });
    expect((await ask()).status).toBe(202);
    await app.linkAsks();
    await e.send();
    const first = e.token();
    expect((await ask()).status).toBe(202);
    await app.linkAsks();
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "sent" }]);
    app.now.value += 16 * MINUTE;
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
    const login = await client.call("POST", "/api/login", {
      body: { key: ADMIN_KEY },
    });
    expect(login.status).toBe(429);
    await e.app.shutdown();
  });

  test("refuses a bad body with a 400", async () => {
    const e = await emailApp();
    for (const body of [{}, { username: "" }, { username: "a".repeat(255) }]) {
      const res = await e.app.client().call("POST", "/api/login/link", {
        body,
      });
      expect(res.status).toBe(400);
    }
    await e.app.shutdown();
  });

  test("an ask after the shutdown's wait answers 202 and does nothing", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const before = await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    expect(before.status).toBe(202);
    // the shutdown waits for the ask it answered
    await app.shutdown();
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "queued" }]);
    // the listener still serves until the db closes
    const after = await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    expect(await shown(after)).toEqual({
      status: 202,
      body: "",
      cookie: null,
      type: null,
    });
    await app.linkAsks();
    expect(e.outbox(maria.id)).toEqual([{ kind: "signin", status: "queued" }]);
    expect(e.links(maria.id).map((link) => link.purpose)).toEqual(["signin"]);
  });

  test("is not there while email is off", async () => {
    const e = await emailApp({ email: false });
    for (const path of ["/api/login/link"]) {
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

describe("the caps on asks", () => {
  const capped = (e: Awaited<ReturnType<typeof emailApp>>) =>
    e.logs.events
      .filter((ev) => ev.msg === "link ask capped")
      .map((ev) => ev.fields);

  test("a user gets 3 asked link emails a day, the 4th answers the same", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const ask = () =>
      app.client().call("POST", "/api/login/link", {
        body: { username: "maria" },
      });
    const start = app.now.value;
    for (let i = 0; i <= ASKED_LINKS_PER_USER_DAY; i++) {
      const res = await ask();
      expect(await shown(res)).toEqual({
        status: 202,
        body: "",
        cookie: null,
        type: null,
      });
      await app.linkAsks();
      await e.send();
      // past the link's life, so the next ask is not limited by it
      app.now.value += 16 * MINUTE;
    }
    expect(app.emailSender.sent).toHaveLength(ASKED_LINKS_PER_USER_DAY);
    expect(capped(e)).toEqual([{ cap: "user", user: "maria" }]);
    // a day after the first, it counts no more
    app.now.value = start + DAY_MS + 1;
    await ask();
    await app.linkAsks();
    expect(await e.send()).toBe(1);
    expect(app.emailSender.sent).toHaveLength(ASKED_LINKS_PER_USER_DAY + 1);
    expect(e.outbox(maria.id)).toHaveLength(ASKED_LINKS_PER_USER_DAY + 1);
    await app.shutdown();
  });

  test("an admin's invites are not counted and not capped", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    for (let i = 0; i <= ASKED_LINKS_PER_USER_DAY; i++) {
      const res = await admin.call("POST", `/api/users/${maria.id}/invite`);
      expect(res.status).toBe(204);
      expect(await e.send()).toBe(1);
    }
    expect(app.email.countAsked(maria.id, 0)).toBe(0);
    await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    expect(await e.send()).toBe(1);
    expect(app.emailSender.sent.at(-1)!.message.subject).toBe(
      "Sign in to 1ctx",
    );
    expect(app.email.countAsked(maria.id, 0)).toBe(1);
    expect(capped(e)).toEqual([]);
    await app.shutdown();
  });

  test("the instance gets 50 an hour across users, and the Monitor says so", async () => {
    const e = await emailApp();
    const { app, admin } = e;
    const attention = async () =>
      (
        (await (await admin.call("GET", "/api/admin/attention")).json()) as {
          items: { kind: string }[];
        }
      ).items.map((item) => item.kind);
    const names: string[] = [];
    for (let i = 0; i <= ASKED_LINKS_PER_HOUR + 1; i++) {
      const name = `user${i}`;
      app.createUser({
        username: name,
        fullName: name,
        email: `${name}@example.test`,
        role: "member",
        now: app.now.value,
      });
      names.push(name);
    }
    const ask = async (i: number) => {
      // one address each, under the login limit
      const res = await app
        .client(`10.2.${i}.1`)
        .call("POST", "/api/login/link", { body: { username: names[i] } });
      expect(res.status).toBe(202);
      await app.linkAsks();
    };
    const start = app.now.value;
    for (let i = 0; i < ASKED_LINKS_PER_HOUR; i++) await ask(i);
    expect(await attention()).toEqual(["links-paused"]);
    await ask(ASKED_LINKS_PER_HOUR);
    expect(await e.send()).toBe(ASKED_LINKS_PER_HOUR);
    expect(capped(e)).toEqual([{ cap: "instance" }]);
    // an admin's invite still goes
    const reset = await admin.call("POST", `/api/users/${e.maria.id}/invite`);
    expect(reset.status).toBe(204);
    expect(await e.send()).toBe(1);
    expect(app.emailSender.sent.at(-1)!.message.to.address).toBe(
      "maria@example.test",
    );
    // shown only while email is on
    await admin.call("PUT", "/api/admin/smtp", {
      body: { ...SMTP, keyName: "email-gone" },
    });
    expect(await attention()).toEqual(["smtp-key"]);
    await admin.call("PUT", "/api/admin/smtp", { body: SMTP });
    expect(await attention()).toEqual(["links-paused"]);
    // an hour after the first, they count no more
    app.now.value = start + HOUR_MS + 1;
    expect(await attention()).toEqual([]);
    await ask(ASKED_LINKS_PER_HOUR + 1);
    expect(await e.send()).toBe(1);
    expect(capped(e)).toHaveLength(1);
    await app.shutdown();
  });

  test("a link still being tried counts while SMTP keeps failing", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    app.emailSender.result = "timeout";
    const issued = () =>
      e.logs.events.filter((ev) => ev.msg === "link issued").length;
    const outcomes: string[] = [];
    let asks = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      if (minute % 22 === 0) {
        const before = [issued(), capped(e).length];
        const res = await app
          .client(`10.3.${asks++}.1`)
          .call("POST", "/api/login/link", { body: { username: "maria" } });
        expect(res.status).toBe(202);
        await app.linkAsks();
        outcomes.push(
          issued() > before[0]!
            ? "issued"
            : capped(e).length > before[1]!
              ? "capped"
              : "live",
        );
      }
      await e.send();
      app.now.value += MINUTE;
    }
    expect(outcomes.filter((o) => o === "issued")).toHaveLength(
      ASKED_LINKS_PER_USER_DAY,
    );
    const first = outcomes.indexOf("capped");
    expect(first).toBeGreaterThan(0);
    expect(outcomes.slice(first).every((o) => o === "capped")).toBe(true);
    expect(e.outbox(maria.id)).toHaveLength(ASKED_LINKS_PER_USER_DAY);
    // four tries each, then failed
    expect(app.emailSender.sent).toHaveLength(4 * ASKED_LINKS_PER_USER_DAY);
    await app.shutdown();
  });

  test("a revoked link's email still counts", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    for (let i = 0; i <= ASKED_LINKS_PER_USER_DAY; i++) {
      await app.client(`10.4.${i}.1`).call("POST", "/api/login/link", {
        body: { username: "maria" },
      });
      await app.linkAsks();
      if (i === ASKED_LINKS_PER_USER_DAY) break;
      // a sign out everywhere revokes the queued link and its email
      const res = await e.admin.call("POST", `/api/users/${maria.id}/sign-out`);
      expect(res.status).toBe(204);
    }
    expect(e.outbox(maria.id).filter((row) => row.kind === "signin")).toEqual(
      Array(ASKED_LINKS_PER_USER_DAY).fill({
        kind: "signin",
        status: "dropped",
      }),
    );
    expect(capped(e)).toEqual([{ cap: "user", user: "maria" }]);
    await app.shutdown();
  });

  test("the sweep at the day's edge keeps the count", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    const start = app.now.value;
    await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    expect(await e.send()).toBe(1);
    app.now.value = start + DAY_MS;
    app.sweep();
    expect(app.email.countAsked(maria.id, app.now.value - DAY_MS)).toBe(1);
    app.now.value += 1;
    app.sweep();
    expect(app.email.countAsked(maria.id, 0)).toBe(0);
    await app.shutdown();
  });
});

describe("a link email", () => {
  test("mints its token at the send, and the expiry counts from then", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    // queued for most of the link's life before it goes out
    app.now.value += 12 * MINUTE;
    expect(await e.send()).toBe(1);
    expect(e.links(maria.id)).toEqual([
      { purpose: "signin", minted: true, used: false },
    ]);
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.to).toEqual({
      name: "Maria Pop",
      address: "maria@example.test",
    });
    expect(message.subject).toBe("Sign in to 1ctx");
    const token = e.token();
    expect(message.text).toContain(`https://1ctx.example.test/link/${token}`);
    expect(message.html).toContain(
      `<a href="https://1ctx.example.test/link/${token}">`,
    );
    expect(message.text).not.toMatch(/[\u2014;]/);
    app.now.value += 14 * MINUTE;
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
  async function sentLink() {
    const e = await emailApp();
    await e.app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await e.app.linkAsks();
    await e.send();
    return { ...e, link: `/api/links/${e.token()}` };
  }

  test("GET has no side effect and is never stored; a dead link is null", async () => {
    const e = await sentLink();
    for (let i = 0; i < 2; i++) {
      const res = await e.app.client().call("GET", e.link);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({
        link: { purpose: "signin", username: "maria" },
      });
    }
    expect(e.links(e.maria.id)).toEqual([
      { purpose: "signin", minted: true, used: false },
    ]);
    // a malformed token and an unknown one read the same
    for (const path of ["/api/links/nope", `/api/links/${"A".repeat(43)}`]) {
      const res = await e.app.client().call("GET", path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ link: null });
    }
    await e.app.shutdown();
  });

  test("a sign in link opens a login, takes no body and works once", async () => {
    const e = await sentLink();
    const { app, maria } = e;
    const elsewhere = app.client();
    expect((await elsewhere.signIn("maria")).status).toBe(200);
    const tab = app.client();
    expect(
      (await tab.call("POST", e.link, { body: { password: "maria-new-pw" } }))
        .status,
    ).toBe(400);
    app.now.value += MINUTE;
    const res = await tab.call("POST", e.link, { body: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ username: "maria" });
    expect(app.users.byId(maria.id)!.signedInAt).toBe(app.now.value);
    // a sign in keeps every other login
    expect(
      (await (await elsewhere.call("GET", "/api/me")).json()).user.username,
    ).toBe("maria");
    expect((await tab.call("POST", e.link, { body: {} })).status).toBe(404);
    expect(e.logs.events.some((ev) => ev.msg === "link used")).toBe(true);
    await app.shutdown();
  });

  test("an expired link and a disabled user's link do nothing", async () => {
    const expired = await sentLink();
    expired.app.now.value += 15 * MINUTE;
    expect(await expired.read(expired.token())).toBeNull();
    const res = await expired.app.client().call("POST", expired.link, {
      body: {},
    });
    expect(res.status).toBe(404);
    expect(expired.app.client().cookie).toBeNull();
    await expired.app.shutdown();

    const disabled = await sentLink();
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

  test("a dead link answers as an unknown one, before the body is read", async () => {
    const e = await sentLink();
    const { app } = e;
    const used = await app.client().call("POST", e.link, { body: {} });
    expect(used.status).toBe(200);
    const fresh = await sentLink();
    const unknown = await shown(
      await app.client().call("POST", `/api/links/${"A".repeat(43)}`, {
        body: {},
      }),
    );
    expect(unknown.status).toBe(404);
    // used: an empty body and one out of shape
    for (const body of [{}, { password: 1 }]) {
      const res = await app.client().call("POST", e.link, { body });
      expect(await shown(res)).toEqual(unknown);
    }
    // expired, never used
    fresh.app.now.value += 16 * MINUTE;
    for (const body of [{}, { password: "x" }]) {
      const res = await fresh.app.client().call("POST", fresh.link, { body });
      expect(await shown(res)).toEqual(unknown);
    }
    await app.shutdown();
    await fresh.app.shutdown();
  });

  test("two uses racing: one wins", async () => {
    const e = await sentLink();
    const [a, b] = await Promise.all([
      e.app.client().call("POST", e.link, { body: {} }),
      e.app.client().call("POST", e.link, { body: {} }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    await e.app.shutdown();
  });

  test("a tab signed in as another account is replaced", async () => {
    const e = await sentLink();
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
    const e = await sentLink();
    const client = e.app.client("10.0.0.7");
    for (let i = 0; i < 10; i++) {
      await client.call("POST", "/api/login", { body: { key: "nope" } });
    }
    expect((await client.call("POST", e.link, { body: {} })).status).toBe(429);
    await e.app.shutdown();
  });
});
