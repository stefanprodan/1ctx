// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin's links and what ends a link: an invite makes a user who
// cannot sign in until the invite sets a password, a reset link is
// never for the admin's own row, every change of password, address or
// state kills the live links and their queued email, and the security
// notice says when and from where, with no link.

import { describe, expect, test } from "bun:test";
import { emailApp, MARIA_PASSWORD } from "../../helpers/links.ts";

const NEW_USER = {
  username: "nina",
  fullName: "Nina Ross",
  email: "nina@example.test",
  role: "member",
  tz: "UTC",
};

describe("invites", () => {
  test("make a must-change user who signs in only through the invite", async () => {
    const e = await emailApp();
    const { app, admin } = e;
    const res = await admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true },
    });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user.mustChangePassword).toBe(true);
    expect(e.outbox(user.id)).toEqual([{ kind: "invite", status: "queued" }]);
    await e.send();
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.subject).toBe("You are invited to 1ctx");
    expect(message.text).toContain("within 7 days");
    const token = e.token();
    // nobody knows the first password
    for (const password of ["", "longenough", MARIA_PASSWORD]) {
      const login = await app.client().login("nina", password || "x");
      expect(login.status).toBe(401);
    }
    const link = await app.client().call("GET", `/api/links/${token}`);
    expect(await link.json()).toEqual({ purpose: "invite", username: "nina" });
    // seven days later it still works
    app.now.value += 7 * 24 * 60 * 60_000 - 1;
    const tab = app.client();
    const used = await tab.call("POST", `/api/links/${token}`, {
      body: { password: "nina-chosen-pw" },
    });
    expect(used.status).toBe(200);
    expect((await used.json()).user.mustChangePassword).toBe(false);
    expect((await app.client().login("nina", "nina-chosen-pw")).status).toBe(
      200,
    );
    // no notice for a first password
    expect(e.outbox(user.id).map((row) => row.kind)).toEqual(["invite"]);
    await app.shutdown();
  });

  test("resent, the last one stops working", async () => {
    const e = await emailApp({ mustChange: true });
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
    expect((await app.client().call("GET", `/api/links/${first}`)).status).toBe(
      404,
    );
    expect(
      (await app.client().call("GET", `/api/links/${e.token()}`)).status,
    ).toBe(200);
    await app.shutdown();
  });

  test("an invite to a placeholder clears the mark once used", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    expect(
      (await admin.call("POST", `/api/users/${maria.id}/invite`)).status,
    ).toBe(204);
    await e.send();
    // marked while the email was out, as a test can only do by hand
    app.db
      .query("update users set email_placeholder = 1 where id = ?")
      .run(maria.id);
    const used = await app.client().call("POST", `/api/links/${e.token()}`, {
      body: { password: "maria-chosen-pw" },
    });
    expect(used.status).toBe(200);
    expect(app.users.byId(maria.id)!.emailPlaceholder).toBe(false);
    await app.shutdown();
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
    const both = await on.admin.call("POST", "/api/users", {
      body: { ...NEW_USER, invite: true, password: "longenough" },
    });
    expect(both.status).toBe(400);
    const adminId = on.app.users.byUsername("admin")!.id;
    expect(
      (await on.admin.call("POST", `/api/users/${adminId}/invite`)).status,
    ).toBe(409);
    expect((await on.admin.call("POST", "/api/users/nope/invite")).status).toBe(
      404,
    );
    await on.app.shutdown();
  });
});

describe("reset links", () => {
  test("go to another user and never to your own row", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    const adminId = app.users.byUsername("admin")!.id;
    const own = await admin.call("POST", `/api/users/${adminId}/reset-link`);
    expect(own.status).toBe(409);
    expect((await own.json()).error).toBe("cannot reset your own password");
    const res = await admin.call("POST", `/api/users/${maria.id}/reset-link`);
    expect(res.status).toBe(204);
    await e.send();
    expect(app.emailSender.sent.at(-1)!.message.subject).toBe(
      "Reset your 1ctx password",
    );
    // sending changes nothing yet: maria is still signed in
    const tab = app.client();
    expect((await tab.login("maria", MARIA_PASSWORD)).status).toBe(200);
    expect((await tab.call("GET", "/api/me")).status).toBe(200);
    const used = await app.client().call("POST", `/api/links/${e.token()}`, {
      body: { password: "maria-reset-pw" },
    });
    expect(used.status).toBe(200);
    expect((await (await tab.call("GET", "/api/me")).json()).user).toBeNull();
    await app.shutdown();
  });

  test("are refused for a disabled user and while email is off", async () => {
    const e = await emailApp();
    await e.admin.call("PATCH", `/api/users/${e.maria.id}`, {
      body: { disabled: true },
    });
    expect(
      (await e.admin.call("POST", `/api/users/${e.maria.id}/reset-link`))
        .status,
    ).toBe(409);
    await e.app.shutdown();
    const off = await emailApp({ email: false });
    expect(
      (await off.admin.call("POST", `/api/users/${off.maria.id}/reset-link`))
        .status,
    ).toBe(409);
    await off.app.shutdown();
  });
});

describe("what ends a link", () => {
  // one sent link per purpose, and a queued one on top
  async function withLinks() {
    const e = await emailApp();
    for (const path of ["/api/login/forgot", "/api/login/link"]) {
      await e.app.client().call("POST", path, { body: { username: "maria" } });
      await e.app.linkAsks();
      await e.send();
    }
    const signin = e.token();
    await e.admin.call("POST", `/api/users/${e.maria.id}/invite`);
    const dead = async () => {
      expect(e.links(e.maria.id).filter((link) => !link.used)).toEqual([]);
      expect(
        e
          .outbox(e.maria.id)
          .filter((row) => row.status === "queued" && row.kind !== "notice"),
      ).toEqual([]);
      const res = await e.app.client().call("POST", `/api/links/${signin}`, {
        body: {},
      });
      expect(res.status).toBe(404);
    };
    return { e, dead };
  }

  test("a password change", async () => {
    const { e, dead } = await withLinks();
    const tab = e.app.client();
    await tab.login("maria", MARIA_PASSWORD);
    const res = await tab.call("POST", "/api/profile/password", {
      body: { current: MARIA_PASSWORD, next: "maria-changed-pw" },
    });
    expect(res.status).toBe(200);
    await dead();
    await e.app.shutdown();
  });

  test("an admin's reset", async () => {
    const { e, dead } = await withLinks();
    const res = await e.admin.call(
      "POST",
      `/api/users/${e.maria.id}/password`,
      { body: { password: "admin-typed-pw" } },
    );
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
    await e.admin.call("POST", `/api/users/${e.maria.id}/reset-link`);
    e.app.db.query("delete from user_links").run();
    const sent = e.app.emailSender.sent.length;
    expect(await e.send()).toBe(1);
    expect(e.app.emailSender.sent.length).toBe(sent);
    expect(e.outbox(e.maria.id)).toEqual([]);
    const dropped = e.logs.events.find((ev) => ev.msg === "email dropped");
    expect(dropped?.fields.reason).toBe("revoked");
    await e.app.shutdown();
  });

  test("the sweep takes links past their expiry", async () => {
    const { e } = await withLinks();
    e.app.now.value += 8 * 24 * 60 * 60_000;
    expect(e.app.sweep()).toBeGreaterThanOrEqual(3);
    expect(e.links(e.maria.id)).toEqual([]);
    await e.app.shutdown();
  });
});

describe("the security notice", () => {
  test("says when, in the user's zone, and from where, with no link", async () => {
    const e = await emailApp();
    const { app, maria } = e;
    // 2026-10-06 11:02 UTC, 14:02 in Bucharest
    app.now.value = Date.UTC(2026, 9, 6, 11, 2);
    const tab = app.client("203.0.113.5");
    await tab.login("maria", MARIA_PASSWORD);
    await tab.call("POST", "/api/profile/password", {
      body: { current: MARIA_PASSWORD, next: "maria-changed-pw" },
    });
    expect(e.outbox(maria.id)).toEqual([{ kind: "notice", status: "queued" }]);
    await e.send();
    const { message } = app.emailSender.sent.at(-1)!;
    expect(message.subject).toBe("Your 1ctx password was changed");
    expect(message.text).toContain(
      "Your password was changed on 6 Oct 2026 at 14:02 (Europe/Bucharest) from 203.0.113.5.",
    );
    expect(message.html).toContain("<p>Hi Maria Pop,</p>");
    expect(message.text).not.toContain("http");
    // a sent row keeps no text
    const row = app.db
      .query<{ body: string | null }, [string]>(
        "select body from email_outbox where user_id = ?",
      )
      .get(maria.id);
    expect(row?.body).toBeNull();
    await app.shutdown();
  });

  test("follows a reset, an admin's reset and a sign in link", async () => {
    const e = await emailApp();
    const { app, admin, maria } = e;
    await app.client().call("POST", "/api/login/link", {
      body: { username: "maria" },
    });
    await app.linkAsks();
    await e.send();
    await app.client().call("POST", `/api/links/${e.token()}`, { body: {} });
    // apart in time, so the outbox sends them in order
    app.now.value += 1000;
    await admin.call("POST", `/api/users/${maria.id}/password`, {
      body: { password: "admin-typed-pw" },
    });
    app.now.value += 1000;
    await admin.call("POST", `/api/users/${maria.id}/reset-link`);
    await e.send();
    await app.client().call("POST", `/api/links/${e.token()}`, {
      body: { password: "maria-reset-pw" },
    });
    await e.send();
    const subjects = app.emailSender.sent.map((s) => s.message.subject);
    expect(subjects).toEqual([
      "Sign in to 1ctx",
      "New sign in to 1ctx",
      "Your 1ctx password was reset",
      "Reset your 1ctx password",
      "Your 1ctx password was reset",
    ]);
    expect(app.emailSender.sent[2]!.message.text).toContain(
      "An admin reset your password",
    );
    await app.shutdown();
  });

  test("is not queued while email is off", async () => {
    const e = await emailApp({ email: false });
    const tab = e.app.client();
    await tab.login("maria", MARIA_PASSWORD);
    const res = await tab.call("POST", "/api/profile/password", {
      body: { current: MARIA_PASSWORD, next: "maria-changed-pw" },
    });
    expect(res.status).toBe(200);
    expect(e.outbox(e.maria.id)).toEqual([]);
    await e.app.shutdown();
  });
});
