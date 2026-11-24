// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cookie, its attributes, revocation on logout, the sliding expiry,
// the same-origin rule on writes, the rate limit, and the bootstrap.

import { describe, expect, test } from "bun:test";
import { LOGIN_TTL_MS, TOUCH_AFTER_MS } from "../../src/server/access/index.ts";
import { LOGIN_LIMIT } from "../../src/server/access/routes.ts";
import { MAX_BODY } from "../../src/server/lib/body.ts";
import { BootstrapError } from "../../src/server/users/index.ts";
import { ADMIN_KEY, collectLogs, testApp } from "../helpers/app.ts";

const byKey = (key: string) => ({ body: { key } });

describe("bootstrap", () => {
  test("creates admin from the key file when there are no users", async () => {
    const app = await testApp();
    const admin = app.users.byUsername("admin");
    expect(admin?.role).toBe("admin");
    expect(JSON.stringify(admin)).not.toContain(ADMIN_KEY);
  });

  test.each([
    ["missing", null, "missing"],
    ["a password", "hunter2-test", "no admin key"],
    ["a key without the prefix", "A".repeat(43), "no admin key"],
  ])(
    "the first start fails when the file is %s",
    async (_case, adminKey, reason) => {
      const failed = await testApp({ adminKey }).catch((error) => error);
      expect(failed).toBeInstanceOf(BootstrapError);
      expect(failed.file).toBe("user-admin.key");
      expect(failed.reason).toBe(reason);
    },
  );

  test("the first start fails naming the file when it cannot be read", async () => {
    const secrets = Object.defineProperty({}, "user-admin", {
      enumerable: true,
      get() {
        throw new Error("EACCES: permission denied");
      },
    });
    const failed = await testApp({ secrets }).catch((error) => error);
    expect(failed).toBeInstanceOf(BootstrapError);
    expect(failed.file).toBe("user-admin.key");
    expect(failed.reason).toBe("unreadable");
  });

  test("a later start ignores the file", async () => {
    const first = await testApp();
    const again = await testApp({ db: first.db, adminKey: null });
    expect(again.users.count()).toBe(1);
  });
});

describe("login", () => {
  test("sets an HttpOnly, SameSite=Lax cookie and answers the user", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.call("POST", "/api/login", byKey(ADMIN_KEY));
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
      },
    });
  });

  test("stores a hash of the token, never the token", async () => {
    const app = await testApp();
    const client = app.client();
    await client.call("POST", "/api/login", byKey(ADMIN_KEY));
    const token = client.cookie!.split("=")[1];
    const rows = app.db
      .query<{ token_hash: string }, []>("select token_hash from logins")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("answers a wrong key and a bad body the same way", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const wrong = await app
      .client()
      .call("POST", "/api/login", byKey(`1ctx-admin-${"B".repeat(43)}`));
    const unknown = await app
      .client()
      .call("POST", "/api/login", { body: { username: "admin" } });
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
    expect(await nobody.json()).toEqual({
      user: null,
      emailOn: false,
      dictationOn: false,
    });
    await client.signIn("admin");
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
      emailOn: false,
      dictationOn: false,
    });
  });
});

describe("logout", () => {
  test("revokes the row and clears the cookie", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
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
      emailOn: false,
      dictationOn: false,
    });
  });

  test("revokes only its own login", async () => {
    const app = await testApp();
    const tab1 = app.client();
    const tab2 = app.client();
    await tab1.signIn("admin");
    await tab2.signIn("admin");
    await tab1.call("POST", "/api/logout");
    expect((await tab2.call("GET", "/api/me")).status).toBe(200);
  });
});

describe("expiry", () => {
  test("slides on use and ends after thirty idle days", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
    app.now.value += LOGIN_TTL_MS - 1000;
    expect((await client.call("GET", "/api/me")).status).toBe(200);
    app.now.value += LOGIN_TTL_MS - 1000;
    expect((await client.call("GET", "/api/me")).status).toBe(200);
    const kept = client.cookie;
    app.now.value += LOGIN_TTL_MS;
    // the browser drops the cookie at its Max-Age
    expect(await (await client.call("GET", "/api/me")).json()).toEqual({
      user: null,
      emailOn: false,
      dictationOn: false,
    });
    // one sent anyway finds the login expired, and ends it
    const stale = app.client();
    stale.cookie = kept;
    expect((await (await stale.call("GET", "/api/me")).json()).user).toBeNull();
    expect(app.db.query("select count(*) as n from logins").get()).toEqual({
      n: 0,
    });
  });
});

describe("same origin", () => {
  test("a write from another origin is refused before the handler", async () => {
    const app = await testApp();
    const client = app.client();
    const res = await client.signIn("admin");
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
      ...byKey(ADMIN_KEY),
      origin: null,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  test("a GET needs no origin", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
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
    const wrong = byKey(`1ctx-admin-${"B".repeat(43)}`);
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect((await client.call("POST", "/api/login", wrong)).status).toBe(401);
    }
    const right = byKey(ADMIN_KEY);
    expect((await client.call("POST", "/api/login", right)).status).toBe(429);
    expect((await client.call("POST", "/api/login", right)).status).toBe(429);
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
      (await app.client("10.0.0.10").call("POST", "/api/login", right)).status,
    ).toBe(200);
    app.now.value += 61_000;
    expect((await client.call("POST", "/api/login", right)).status).toBe(200);
  });
});

describe("the sliding cookie", () => {
  test("is re-sent with a full Max-Age once an hour has passed", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
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
    await client.signIn("admin");
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
    await app.client().signIn("admin");
    app.now.value += LOGIN_TTL_MS / 2;
    await app.client().signIn("admin");
    app.now.value += LOGIN_TTL_MS / 2;
    expect(app.sweep()).toBe(1);
    expect(logs.events.findLast((event) => event.msg === "sweep")).toEqual({
      level: "info",
      area: "sweep",
      msg: "sweep",
      fields: {
        logins: 1,
        links: 0,
        visits: 0,
        knowledge: 0,
        images: 0,
        bash: 0,
        digests: 0,
        not_sent: 0,
        emails: 0,
        external_access_gone: 0,
        external_idle: 0,
        external_deleted: 0,
        removed: 1,
        turns_swept: 0,
        chats_archived: 0,
        chats_packed: 0,
        scratch_freed: 0,
        runs_packed: 0,
        chats_deleted: 0,
        runs_deleted: 0,
        drafts_expired: 0,
      },
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
      raw: JSON.stringify({ key: "x".repeat(MAX_BODY) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("a trusted proxy", () => {
  test("rate limits by the forwarded address", async () => {
    const app = await testApp({ trustProxy: true });
    const proxied = (ip: string) =>
      app.client("127.0.0.1").call("POST", "/api/login", {
        body: { key: `1ctx-admin-${"B".repeat(43)}` },
        headers: { "x-forwarded-for": ip },
      });
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      expect((await proxied("10.0.0.1")).status).toBe(401);
    }
    expect((await proxied("10.0.0.1")).status).toBe(429);
    expect((await proxied("10.0.0.2")).status).toBe(401);
  });
});
