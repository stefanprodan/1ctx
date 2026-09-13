// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile routes: the row, the full name, and a password change
// that proves the current one, keeps this login and revokes the rest.

import { describe, expect, test } from "bun:test";
import { PASSWORD_LIMIT } from "../../src/server/access/profile.ts";
import { subscribe } from "../../src/server/lib/bus.ts";
import { testApp } from "../helpers/app.ts";

describe("GET /api/profile", () => {
  test("answers the signed-in user's row without the hash", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const res = await client.call("GET", "/api/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: expect.any(String),
        username: "admin",
        fullName: "Administrator",
        email: "admin@1ctx.dev",
        about: "",
        role: "admin",
        createdAt: app.now.value,
        disabled: false,
        mustChangePassword: false,
      },
    });
  });
});

describe("PATCH /api/profile", () => {
  test("changes the full name and the about text, and me follows", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const res = await client.call("PATCH", "/api/profile", {
      body: { fullName: "Oana Pellea", about: "Actor." },
    });
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user.fullName).toBe("Oana Pellea");
    expect(user.about).toBe("Actor.");
    expect(app.users.byUsername("admin")?.about).toBe("Actor.");
    const me = await (await client.call("GET", "/api/me")).json();
    expect(me.user.fullName).toBe("Oana Pellea");
    expect(me.user.about).toBeUndefined();
    expect(me.user.username).toBe("admin");
  });

  test("refuses a bad name with a 400 and keeps the old one", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const res = await client.call("PATCH", "/api/profile", {
      body: { fullName: "  ", about: "" },
    });
    expect(res.status).toBe(400);
    expect(app.users.byUsername("admin")?.fullName).toBe("Administrator");
  });
});

describe("POST /api/profile/password", () => {
  test("needs the current password", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const res = await client.call("POST", "/api/profile/password", {
      body: { current: "nope", next: "longenough" },
    });
    // a 403, since a 401 would make the client drop the signed-in user
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "the current password is wrong",
    });
    // the wrong guess did not sign this tab out
    expect((await client.call("GET", "/api/me")).status).toBe(200);
    expect((await app.client().login("admin", "hunter2-test")).status).toBe(
      200,
    );
  });

  test("replaces it, keeps this login and revokes the others", async () => {
    const app = await testApp();
    const here = app.client();
    const elsewhere = app.client();
    await here.login("admin", "hunter2-test");
    await elsewhere.login("admin", "hunter2-test");
    const events: unknown[] = [];
    const off = subscribe((e) => events.push(e));
    const res = await here.call("POST", "/api/profile/password", {
      body: { current: "hunter2-test", next: "longenough" },
    });
    off();
    expect(res.status).toBe(200);
    expect((await here.call("GET", "/api/me")).status).toBe(200);
    expect(await (await elsewhere.call("GET", "/api/me")).json()).toEqual({
      user: null,
    });
    expect((await app.client().login("admin", "hunter2-test")).status).toBe(
      401,
    );
    expect((await app.client().login("admin", "longenough")).status).toBe(200);
    expect(events).toEqual([
      {
        type: "login.revoked",
        data: { userId: expect.any(String), loginId: null },
      },
    ]);
  });

  test("two changes racing with the same current password: one wins", async () => {
    const app = await testApp();
    const here = app.client();
    const elsewhere = app.client();
    await here.login("admin", "hunter2-test");
    await elsewhere.login("admin", "hunter2-test");
    const change = (client: typeof here, next: string) =>
      client.call("POST", "/api/profile/password", {
        body: { current: "hunter2-test", next },
      });
    const [a, b] = await Promise.all([
      change(here, "first-choice"),
      change(elsewhere, "second-choice"),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 403]);
    // the winner's login is the only one left, and only its password works
    const winner = a.status === 200 ? here : elsewhere;
    const loser = a.status === 200 ? elsewhere : here;
    const password = a.status === 200 ? "first-choice" : "second-choice";
    const other = a.status === 200 ? "second-choice" : "first-choice";
    expect((await winner.call("GET", "/api/me")).status).toBe(200);
    expect(await (await loser.call("GET", "/api/me")).json()).toEqual({
      user: null,
    });
    expect((await app.client().login("admin", password)).status).toBe(200);
    expect((await app.client().login("admin", other)).status).toBe(401);
  });

  test("publishes nothing when there was no other login", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const events: unknown[] = [];
    const off = subscribe((e) => events.push(e));
    await client.call("POST", "/api/profile/password", {
      body: { current: "hunter2-test", next: "longenough" },
    });
    off();
    expect(events).toEqual([]);
  });

  test("limits the guesses at the current password per user", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const guess = () =>
      client.call("POST", "/api/profile/password", {
        body: { current: "nope", next: "longenough" },
      });
    for (let i = 0; i < PASSWORD_LIMIT; i++) {
      expect((await guess()).status).toBe(403);
    }
    expect((await guess()).status).toBe(429);
    app.now.value += 61_000;
    expect((await guess()).status).toBe(403);
  });
});
