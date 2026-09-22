// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cookie, its attributes, revocation on logout, the sliding expiry,
// the same-origin rule on writes, the rate limit, and the bootstrap.

import { describe, expect, test } from "bun:test";
import { LOGIN_TTL_MS, TOUCH_AFTER_MS } from "../../src/server/access/index.ts";
import { LOGIN_LIMIT } from "../../src/server/access/routes.ts";
import { MAX_BODY } from "../../src/server/lib/body.ts";
import { collectLogs, testApp } from "../helpers/app.ts";

describe("bootstrap", () => {
  test("creates admin from the secret when there are no users", async () => {
    const app = await testApp({ adminPassword: "s3cret-key" });
    const admin = app.users.byUsername("admin");
    expect(admin?.role).toBe("admin");
    expect(admin?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(admin?.passwordHash).not.toContain("s3cret-key");
  });

  test("refuses a secret under the password floor", async () => {
    const app = await testApp({ adminPassword: "short" });
    expect(app.users.count()).toBe(0);
  });

  test("refuses a secret over the password cap", async () => {
    const app = await testApp({ adminPassword: "x".repeat(1025) });
    expect(app.users.count()).toBe(0);
  });

  test("creates nobody without the secret", async () => {
    const app = await testApp({ adminPassword: null });
    expect(app.users.count()).toBe(0);
  });
});

describe("login", () => {
  test("sets an HttpOnly, SameSite=Lax cookie and answers the user", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.login("admin", "hunter2-test");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(
      /^login=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    expect(await res.json()).toEqual({
      user: {
        id: expect.any(String),
        username: "admin",
        fullName: "Administrator",
        role: "admin",
        mustChangePassword: false,
      },
    });
  });

  test("stores a hash of the token, never the token", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const token = client.cookie!.split("=")[1];
    const rows = app.db
      .query<{ token_hash: string }, []>("select token_hash from logins")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("answers a wrong password and an unknown username the same way", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const wrong = await app.client().login("admin", "nope");
    const unknown = await app.client().login("ghost", "nope");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(logs.events.filter((event) => event.msg === "login failed")).toEqual(
      [
        {
          level: "warn",
          area: "access",
          msg: "login failed",
          fields: { addr: "127.0.0.1" },
        },
        {
          level: "warn",
          area: "access",
          msg: "login failed",
          fields: { addr: "127.0.0.1" },
        },
      ],
    );
  });

  test("me answers the user with the cookie and null without", async () => {
    const app = await testApp();
    const client = app.client();
    const nobody = await client.call("GET", "/api/me");
    expect(nobody.status).toBe(200);
    expect(await nobody.json()).toEqual({ user: null });
    await client.login("admin", "hunter2-test");
    const res = await client.call("GET", "/api/me");
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe("admin");
  });

  test("a forged cookie is nobody", async () => {
    const app = await testApp();
    const client = app.client();
    client.cookie = "login=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(await (await client.call("GET", "/api/me")).json()).toEqual({
      user: null,
    });
  });
});

describe("logout", () => {
  test("revokes the row and clears the cookie", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const token = client.cookie!;
    const res = await client.call("POST", "/api/logout");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(
      /^login=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/,
    );
    expect(app.db.query("select count(*) as n from logins").get()).toEqual({
      n: 0,
    });
    // the old cookie, replayed, is nobody
    client.cookie = token;
    expect(await (await client.call("GET", "/api/me")).json()).toEqual({
      user: null,
    });
  });

  test("revokes only its own login", async () => {
    const app = await testApp();
    const tab1 = app.client();
    const tab2 = app.client();
    await tab1.login("admin", "hunter2-test");
    await tab2.login("admin", "hunter2-test");
    await tab1.call("POST", "/api/logout");
    expect((await tab2.call("GET", "/api/me")).status).toBe(200);
  });
});

describe("expiry", () => {
  test("slides on use and ends after thirty idle days", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    app.now.value += LOGIN_TTL_MS - 1000;
    expect((await client.call("GET", "/api/me")).status).toBe(200);
    app.now.value += LOGIN_TTL_MS - 1000;
    expect((await client.call("GET", "/api/me")).status).toBe(200);
    app.now.value += LOGIN_TTL_MS;
    expect(await (await client.call("GET", "/api/me")).json()).toEqual({
      user: null,
    });
    expect(app.db.query("select count(*) as n from logins").get()).toEqual({
      n: 0,
    });
  });
});

describe("same origin", () => {
  test("a write from another origin is refused before the handler", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.login("admin", "hunter2-test");
    expect(res.status).toBe(200);
    const cross = await client.call("POST", "/api/logout", {
      origin: "http://evil.test",
    });
    expect(cross.status).toBe(403);
    expect((await client.call("GET", "/api/me")).status).toBe(200);
  });

  test("a write with no origin but a fetch site is refused", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.call("POST", "/api/login", {
      body: { username: "admin", password: "hunter2-test" },
      origin: null,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  test("a GET needs no origin", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    expect((await client.call("GET", "/api/me", { origin: null })).status).toBe(
      200,
    );
  });
});

describe("rate limit", () => {
  test("blocks an address after the limit within a minute", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const client = app.client("10.0.0.9");
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect((await client.login("admin", "wrong")).status).toBe(401);
    }
    expect((await client.login("admin", "hunter2-test")).status).toBe(429);
    expect((await client.login("admin", "hunter2-test")).status).toBe(429);
    const limited = logs.events.filter((e) => e.msg === "login limited");
    // once when the window closes, never per refusal
    expect(limited).toHaveLength(1);
    expect(limited[0]).toEqual({
      level: "warn",
      area: "access",
      msg: "login limited",
      fields: { addr: "10.0.0.9" },
    });
    expect(
      (await app.client("10.0.0.10").login("admin", "hunter2-test")).status,
    ).toBe(200);
    app.now.value += 61_000;
    expect((await client.login("admin", "hunter2-test")).status).toBe(200);
  });
});

describe("the sliding cookie", () => {
  test("is re-sent with a full Max-Age once an hour has passed", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const first = client.cookie!;
    // within the hour nothing is re-sent
    app.now.value += TOUCH_AFTER_MS - 1;
    const quiet = await client.call("GET", "/api/me");
    expect(quiet.headers.get("set-cookie")).toBeNull();
    app.now.value += 1;
    const renewed = await client.call("GET", "/api/me");
    expect(renewed.headers.get("set-cookie")).toBe(
      `${first}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}`,
    );
    expect(client.cookie).toBe(first);
    // the row moved with it
    const row = app.db
      .query<{ expires_at: number }, []>("select expires_at from logins")
      .get()!;
    expect(row.expires_at).toBe(app.now.value + LOGIN_TTL_MS);
  });

  test("logout wins over a renewal on the same response", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    app.now.value += TOUCH_AFTER_MS;
    const res = await client.call("POST", "/api/logout");
    expect(res.headers.get("set-cookie")).toMatch(/^login=; /);
    expect(client.cookie).toBeNull();
  });
});

describe("sweep", () => {
  test("removes the rows whose expiry passed", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    await app.client().login("admin", "hunter2-test");
    app.now.value += LOGIN_TTL_MS / 2;
    await app.client().login("admin", "hunter2-test");
    app.now.value += LOGIN_TTL_MS / 2;
    expect(app.sweep()).toBe(1);
    expect(logs.events.findLast((event) => event.msg === "sweep")).toEqual({
      level: "info",
      area: "sweep",
      msg: "sweep",
      fields: { logins: 1, knowledge: 0, digests: 0, removed: 1 },
    });
    expect(app.db.query("select count(*) as n from logins").get()).toEqual({
      n: 1,
    });
  });
});

describe("the body cap", () => {
  test("a login body over the cap is a 413 before parsing", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.call("POST", "/api/login", {
      raw: JSON.stringify({
        username: "admin",
        password: "x".repeat(MAX_BODY),
      }),
    });
    expect(res.status).toBe(413);
  });

  test("a password over its cap is a 400", async () => {
    const app = await testApp();
    const res = await app.client().login("admin", "x".repeat(1025));
    expect(res.status).toBe(400);
  });
});

describe("a trusted proxy", () => {
  test("rate limits by the forwarded address", async () => {
    const app = await testApp({ trustProxy: true });
    const proxied = (ip: string) =>
      app.client("127.0.0.1").call("POST", "/api/login", {
        body: { username: "admin", password: "wrong" },
        headers: { "x-forwarded-for": ip },
      });
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect((await proxied("10.0.0.1")).status).toBe(401);
    }
    expect((await proxied("10.0.0.1")).status).toBe(429);
    expect((await proxied("10.0.0.2")).status).toBe(401);
  });
});
