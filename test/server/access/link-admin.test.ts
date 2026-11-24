// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin's links and what ends a link: an invite opens a user's first
// login and goes again only until it, sign out everywhere and every
// change of address or state kill the live links and their queued
// email, and the security notice says when and from where, with no link.

import { describe, expect, test } from "bun:test";
import { emailApp } from "../../helpers/links.ts";

const NEW_USER = {
  username: "nina",
  fullName: "Nina Ross",
  email: "nina@example.test",
  role: "member",
  tz: "UTC",
};

describe("invites", () => {
  test("make a user who signs in through the invite", async () => {
    const e = await emailApp();
    const { app, admin } = e;
    const res = await admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true },
    });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user.signedInAt).toBeNull();
    expect(e.outbox(user.id)).toEqual([{ kind: "invite", status: "queued" }]);
    await e.send();
    const { message } = app.emailSender.sent.at(-1)!;
    const token = e.token();
    const code = e.code();
    expect(message.subject).toBe(`Your 1ctx sign-in code: ${code}`);
    expect(message.text).toBe(
      `You were added to 1ctx. Sign in: https://1ctx.example.test/link/${token}, or enter ${code}. Both work once, for 7 days.\n`,
    );
    expect(message.html).toBeUndefined();
    expect(e.live(token)).toBe(true);
    // seven days later it still works
    app.now.value += 7 * 24 * 60 * 60_000 - 1;
    const tab = app.client();
    const used = await e.use(tab, token);
    expect(used.status).toBe(303);
    expect(
      (await (await tab.call("GET", "/api/me")).json()).user.username,
    ).toBe("nina");
    expect(app.users.byId(user.id)!.signedInAt).toBe(app.now.value);
    // no notice for an invite
    expect(e.outbox(user.id).map((row) => row.kind)).toEqual(["invite"]);
    // signed in once, it goes no more
    expect(
      (await admin.call("POST", `/api/users/${user.id}/invite`)).status,
    ).toBe(409);
    await app.shutdown();
  });

  test("resent, the last one stops working", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    const send = () => admin.call("POST", `/api/users/${maria.id}/invite`);
    expect((await send()).status).toBe(204);
    await e.send();
    const first = e.token();
    // a resend while one is still queued replaces its email too
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(204);
    expect(e.outbox(maria.id)).toEqual([
      { kind: "invite", status: "sent" },
      { kind: "invite", status: "queued" },
    ]);
    await e.send();
    expect(e.live(first)).toBe(false);
    expect(e.live(e.token())).toBe(true);
    await app.shutdown();
  });

  test("are refused to a user who signed in", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    await app.client().signIn("maria");
    const res = await admin.call("POST", `/api/users/${maria.id}/invite`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("the user has signed in already");
    expect(e.outbox(maria.id)).toEqual([]);
    expect(e.links(maria.id)).toEqual([]);
    await app.shutdown();
  });

  test("are refused for a user made disabled", async () => {
    const e = await emailApp();
    const res = await e.admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true, disabled: true },
    });
    expect(res.status).toBe(400);
    expect(e.app.users.byUsername("nina")).toBeNull();
    await e.app.shutdown();
  });

  test("are refused while email is off, to a placeholder and to yourself", async () => {
    const off = await emailApp({ email: false });
    const create = await off.admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true },
    });
    expect(create.status).toBe(409);
    expect(off.app.users.byUsername("nina")).toBeNull();
    expect(
      (await off.admin.call("POST", `/api/users/${off.maria.id}/invite`))
        .status,
    ).toBe(409);
    await off.app.shutdown();

    const on = await emailApp();
    const placeholder = await on.admin.call("POST", "/api/users", {
      body: { ...NEW_USER, email: "nina@1ctx.dev", invite: true },
    });
    expect(placeholder.status).toBe(409);
    expect((await placeholder.json()).error).toStartWith("email");
    const password = await on.admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true, password: "longenough" },
    });
    expect(password.status).toBe(400);
    const adminId = on.app.users.byUsername("admin")!.id;
    expect(
      (await on.admin.call("POST", `/api/users/${adminId}/invite`)).status,
    ).toBe(409);
    expect((await on.admin.call("POST", "/api/users/nope/invite")).status).toBe(
      404,
    );
    await on.app.shutdown();
  });

  test("an invite's code works beside any asking browser's cookie", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    await admin.call("POST", `/api/users/${maria.id}/invite`);
    await e.send();
    const code = e.code();
    // no browser asked for it, but a code is tried only beside a cookie
    const bare = app.client("10.7.0.1");
    expect((await e.sendCode(bare, code)).status).toBe(401);
    // a browser that asked for someone else holds a cookie
    const tab = app.client("10.7.0.2");
    expect((await e.ask(tab, "nobody@example.test")).status).toBe(202);
    const res = await e.sendCode(tab, code);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { username: "maria" },
      landing: "/",
    });
    expect(app.users.byId(maria.id)!.signedInAt).toBe(app.now.value);
    // no notice for an invite, and using the code used the link
    expect(e.outbox(maria.id).map((row) => row.kind)).toEqual(["invite"]);
    expect(e.live(e.token())).toBe(false);
    await app.shutdown();
  });

  test("an invite's fifth wrong code ends its code, never its link", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    await admin.call("POST", `/api/users/${maria.id}/invite`);
    await e.send();
    const code = e.code();
    const wrong = code === "000000" ? "111111" : "000000";
    // misses from every browser count on the link
    for (let i = 0; i < 5; i++) {
      const tab = app.client(`10.8.0.${i}`);
      await e.ask(tab, "nobody@example.test");
      expect((await e.sendCode(tab, wrong)).status).toBe(401);
    }
    const tab = app.client("10.8.1.1");
    await e.ask(tab, "nobody@example.test");
    expect((await e.sendCode(tab, code)).status).toBe(401);
    expect(e.live(e.token())).toBe(true);
    expect((await e.use(tab, e.token())).status).toBe(303);
    await app.shutdown();
  });

  test("a user made without one gets no email", async () => {
    const e = await emailApp();
    const res = await e.admin.call("POST", "/api/users", { body: NEW_USER });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(e.outbox(user.id)).toEqual([]);
    await e.app.shutdown();
  });
});

describe("what ends a link", () => {
  // a sent sign in link, and a queued invite on top
  async function withLinks() {
    const e = await emailApp();
    await e.ask(e.app.client());
    await e.app.linkAsks();
    await e.send();
    const signin = e.token();
    await e.admin.call("POST", `/api/users/${e.maria.id}/invite`);
    const dead = async () => {
      expect(e.links(e.maria.id).filter((link) => !link.used)).toEqual([]);
      expect(
        e
          .outbox(e.maria.id)
          .filter((row) => row.status === "queued" && row.kind !== "notice"),
      ).toEqual([]);
      const res = await e.use(e.app.client(), signin);
      expect(res.status).toBe(404);
    };
    return { e, dead };
  }

  test("a sign out everywhere", async () => {
    const { e, dead } = await withLinks();
    const res = await e.admin.call("POST", `/api/users/${e.maria.id}/sign-out`);
    expect(res.status).toBe(204);
    await dead();
    await e.app.shutdown();
  });

  test("a disable", async () => {
    const { e, dead } = await withLinks();
    await e.admin.call("PATCH", `/api/users/${e.maria.id}`, {
      body: { disabled: true },
    });
    await dead();
    await e.app.shutdown();
  });

  test("an email change", async () => {
    const { e, dead } = await withLinks();
    const res = await e.admin.call("PATCH", `/api/users/${e.maria.id}`, {
      body: { email: "maria@elsewhere.test" },
    });
    expect(res.status).toBe(200);
    await dead();
    await e.app.shutdown();
  });

  test("a queued link email whose link is gone is dropped", async () => {
    const e = await emailApp();
    await e.admin.call("POST", `/api/users/${e.maria.id}/invite`);
    e.app.db.query("delete from user_links").run();
    const sent = e.app.emailSender.sent.length;
    expect(await e.send()).toBe(1);
    expect(e.app.emailSender.sent.length).toBe(sent);
    expect(e.outbox(e.maria.id)).toEqual([]);
    const dropped = e.logs.events.find((ev) => ev.msg === "email dropped");
    expect(dropped?.fields.reason).toBe("revoked");
    await e.app.shutdown();
  });

  test("the sweep leaves a link an hour past its expiry", async () => {
    const { e } = await withLinks();
    const expiries = () =>
      e.app.db
        .query<{ expires_at: number }, [string]>(
          "select expires_at from user_links where user_id = ?",
        )
        .all(e.maria.id)
        .map((row) => row.expires_at);
    const latest = Math.max(...expiries());
    e.app.now.value = latest + 59 * 60_000;
    e.app.sweep();
    expect(expiries()).toContain(latest);
    e.app.now.value = latest + 60 * 60_000;
    e.app.sweep();
    expect(expiries()).not.toContain(latest);
    await e.app.shutdown();
  });

  test("a sweep between tries leaves a failing link email failing", async () => {
    const e = await emailApp();
    e.app.emailSender.result = "timeout";
    await e.ask(e.app.client());
    await e.app.linkAsks();
    for (let minute = 0; minute < 60; minute++) {
      if (minute === 30) e.app.sweep();
      await e.send();
      e.app.now.value += 60_000;
    }
    expect(e.app.emailSender.sent.length).toBe(4);
    expect(e.logs.events.some((ev) => ev.msg === "email dropped")).toBe(false);
    expect(e.app.email.attention()?.failed).toBe(1);
    await e.app.shutdown();
  });

  test("the sweep takes links past their expiry", async () => {
    const { e } = await withLinks();
    e.app.now.value += 8 * 24 * 60 * 60_000;
    expect(e.app.sweep()).toBeGreaterThanOrEqual(2);
    expect(e.links(e.maria.id)).toEqual([]);
    await e.app.shutdown();
  });
});

describe("the security notice", () => {
  test("follows a sign in link: when, in the user's zone, and from where", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    // 2026-10-06 11:02 UTC, 14:02 in Bucharest
    app.now.value = Date.UTC(2026, 9, 6, 11, 2);
    await e.ask(app.client());
    await app.linkAsks();
    await e.send();
    const tab = app.client("203.0.113.5");
    expect((await e.use(tab, e.token())).status).toBe(303);
    expect(e.outbox(maria.id).at(-1)).toEqual({
      kind: "notice",
      status: "queued",
    });
    await e.send();
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.subject).toBe("New sign in to 1ctx");
    expect(message.text).toContain(
      "You signed in by email link on 6 Oct 2026 at 14:02 (Europe/Bucharest) from 203.0.113.5.",
    );
    expect(message.text).toContain("If this was not you, tell your admin.");
    expect(message.html).toContain("<p>Hi Maria Pop,</p>");
    expect(message.text).not.toContain("http");
    expect(message.text).not.toMatch(/\d{6}/);
    // a sent row keeps no text
    const rows = app.db
      .query<{ body: string | null }, [string]>(
        "select body from email_outbox where user_id = ?",
      )
      .all(maria.id);
    expect(rows.every((row) => row.body === null)).toBe(true);
    await app.shutdown();
  });

  test("sign out everywhere queues none", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    await admin.call("POST", `/api/users/${maria.id}/sign-out`);
    expect(e.outbox(maria.id)).toEqual([]);
    await app.shutdown();
  });
});
