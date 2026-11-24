// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin key signs in to the web app: the file of an enabled admin,
// read at each sign-in, and its login only while the file still holds
// the key it opened with.

import { describe, expect, test } from "bun:test";
import type { ConnData } from "../../../src/server/web/socket.ts";
import {
  ADMIN_KEY,
  collectLogs,
  ORIGIN,
  type TestApp,
  type TestClient,
  testApp,
} from "../../helpers/app.ts";
import { emailApp } from "../../helpers/links.ts";

const key = (c: string) => `1ctx-admin-${c.repeat(43)}`;
const OPS = key("o");
const CASEY = key("c");

async function setup(extra: Record<string, string> = {}) {
  const secrets: Record<string, string> = {
    "user-ops": OPS,
    "user-casey": CASEY,
    ...extra,
  };
  const logs = collectLogs();
  const app = await testApp({ secrets, logFactory: logs.logFactory });
  const make = (username: string, role: "admin" | "member") =>
    app.createUser({
      username,
      fullName: username,
      email: `${username}@example.test`,
      role,
      now: app.now.value,
    });
  const ops = make("ops", "admin");
  const casey = make("casey", "member");
  const admin = app.client();
  expect((await admin.signIn("admin")).status).toBe(200);
  return { app, secrets, logs, ops, casey, admin };
}

const signIn = (client: TestClient, value: unknown) =>
  client.call("POST", "/api/login", { body: { key: value } });

const me = async (client: TestClient) =>
  (await (await client.call("GET", "/api/me")).json()).user?.username ?? null;

const logins = (app: TestApp) =>
  app.db.query<{ n: number }, []>("select count(*) as n from logins").get()!.n;

describe("signing in by key", () => {
  test("each admin's key signs in as that admin", async () => {
    const { app } = await setup();
    for (const [value, username] of [
      [ADMIN_KEY, "admin"],
      [OPS, "ops"],
    ] as const) {
      const client = app.client();
      const res = await signIn(client, value);
      expect(res.status).toBe(200);
      expect((await res.json()).user.username).toBe(username);
      expect(await me(client)).toBe(username);
    }
    const row = app.db
      .query<{ key_digest: string | null }, []>(
        "select key_digest from logins where key_digest is not null limit 1",
      )
      .get()!;
    expect(row.key_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(OPS);
  });

  test("a sign-in records the user's first sign-in", async () => {
    const { app, ops } = await setup();
    expect(app.users.byId(ops.id)!.signedInAt).toBeNull();
    await signIn(app.client(), OPS);
    expect(app.users.byId(ops.id)!.signedInAt).toBe(app.now.value);
  });

  test.each([
    ["a member's file", () => CASEY],
    ["a key in no file", () => key("z")],
    ["a key without the prefix", () => "A".repeat(43)],
    ["a cut key", () => OPS.slice(0, 40)],
    ["a number", () => 7],
  ])("%s is the one 401", async (_case, value) => {
    const { app, logs } = await setup();
    const res = await signIn(app.client(), value());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "wrong admin key" });
    expect(res.headers.get("set-cookie")).toBeNull();
    const failed = logs.events.filter((e) => e.msg === "login failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("1ctx-admin-");
  });

  test("a malformed file signs in nobody", async () => {
    const { app } = await setup({ "user-ops": "hunter2-test" });
    expect((await signIn(app.client(), "hunter2-test")).status).toBe(401);
  });

  test("a disabled admin's key is the one 401", async () => {
    const { app, admin, ops } = await setup();
    await admin.call("PATCH", `/api/users/${ops.id}`, {
      body: { disabled: true },
    });
    expect((await signIn(app.client(), OPS)).status).toBe(401);
  });

  test("two files holding one key sign in neither, and the start says so", async () => {
    const { app, logs } = await setup({ "user-twin": OPS });
    expect((await signIn(app.client(), OPS)).status).toBe(401);
    expect(logs.events.find((e) => e.msg === "admin keys shared")).toEqual({
      level: "warn",
      area: "access",
      msg: "admin keys shared",
      fields: { files: "user-ops.key,user-twin.key" },
    });
  });

  test("a key file added is read at the next sign-in", async () => {
    const { app, secrets } = await setup();
    delete secrets["user-ops"];
    expect((await signIn(app.client(), OPS)).status).toBe(401);
    secrets["user-ops"] = OPS;
    expect((await signIn(app.client(), OPS)).status).toBe(200);
  });

  test("an unreadable file fails only its own key", async () => {
    const { app, secrets } = await setup();
    const tab = app.client();
    expect((await signIn(tab, OPS)).status).toBe(200);
    const admin = app.client();
    expect((await signIn(admin, ADMIN_KEY)).status).toBe(200);
    Object.defineProperty(secrets, "user-ops", {
      enumerable: true,
      get() {
        throw new Error("EACCES: permission denied");
      },
    });
    expect((await signIn(app.client(), OPS)).status).toBe(401);
    expect(await me(tab)).toBeNull();
    expect(await me(admin)).toBe("admin");
    expect((await signIn(app.client(), ADMIN_KEY)).status).toBe(200);
  });

  test("a key folder that cannot be listed is the one 401, and email still signs in", async () => {
    // from the start, so its duplicate check meets it too
    const e = await emailApp({ unlistable: (kind) => kind === "user-" });
    const { app } = e;
    try {
      const res = await signIn(app.client(), ADMIN_KEY);
      expect(res.status).toBe(401);
      const unlisted = e.logs.events.filter(
        (event) => event.msg === "admin keys unlisted",
      );
      expect(unlisted.length).toBeGreaterThan(0);
      for (const event of unlisted) expect(event.fields).toEqual({});
      const tab = app.client();
      await tab.call("POST", "/api/login/link", {
        body: { username: "maria" },
      });
      await app.linkAsks();
      await e.send();
      const used = await tab.call("POST", `/api/links/${e.token()}`, {
        body: {},
      });
      expect(used.status).toBe(200);
      expect(await me(tab)).toBe("maria");
    } finally {
      await app.shutdown();
    }
  });

  test("a sign-in ends the browser's previous login", async () => {
    const { app, admin } = await setup();
    expect(logins(app)).toBe(1);
    expect((await signIn(admin, OPS)).status).toBe(200);
    expect(logins(app)).toBe(1);
    expect(await me(admin)).toBe("ops");
  });
});

describe("a key login ends", () => {
  const endings: [string, (s: Awaited<ReturnType<typeof setup>>) => unknown][] =
    [
      ["its file changed", (s) => (s.secrets["user-ops"] = key("n"))],
      ["its file removed", (s) => delete s.secrets["user-ops"]],
      [
        "a demote",
        (s) =>
          s.admin.call("PATCH", `/api/users/${s.ops.id}`, {
            body: { role: "member" },
          }),
      ],
      [
        "a disable",
        (s) =>
          s.admin.call("PATCH", `/api/users/${s.ops.id}`, {
            body: { disabled: true },
          }),
      ],
      [
        "a rename",
        (s) =>
          s.admin.call("PATCH", `/api/users/${s.ops.id}`, {
            body: { username: "ops2" },
          }),
      ],
    ];

  test.each(endings)("after %s", async (_case, end) => {
    const s = await setup();
    const tab = s.app.client();
    expect((await signIn(tab, OPS)).status).toBe(200);
    await end(s);
    expect(await me(tab)).toBeNull();
    expect(
      s.app.db
        .query("select count(*) as n from logins where key_digest is not null")
        .get(),
    ).toEqual({ n: 0 });
  });

  test("a rename and a demote end key logins in their write, never email ones", async () => {
    const s = await setup();
    const rows = (userId: string) =>
      s.app.db
        .query<{ key: number }, [string]>(
          "select key_digest is not null as key from logins where user_id = ? order by key",
        )
        .all(userId)
        .map((row) => row.key);
    const byEmail = s.app.client();
    await byEmail.signIn("ops");
    const byKey = async () => {
      expect((await signIn(s.app.client(), OPS)).status).toBe(200);
      expect(rows(s.ops.id)).toEqual([0, 1]);
    };
    const patch = async (body: unknown) =>
      expect(
        (await s.admin.call("PATCH", `/api/users/${s.ops.id}`, { body }))
          .status,
      ).toBe(200);
    await byKey();
    await patch({ username: "ops2" });
    expect(rows(s.ops.id)).toEqual([0]);
    await patch({ username: "ops" });
    await byKey();
    await patch({ role: "member" });
    expect(rows(s.ops.id)).toEqual([0]);
    await patch({ role: "admin" });
    expect(rows(s.ops.id)).toEqual([0]);
    expect(await me(byEmail)).toBe("ops");
  });

  test("a login by email outlives a changed key file", async () => {
    const s = await setup();
    const tab = s.app.client();
    await tab.signIn("ops");
    s.secrets["user-ops"] = key("n");
    expect(await me(tab)).toBe("ops");
  });

  test("the minute's check closes a socket that sends nothing", async () => {
    const s = await setup();
    const tab = s.app.client();
    expect((await signIn(tab, OPS)).status).toBe(200);
    let captured: ConnData | null = null;
    await s.app.handle(
      new Request(`${ORIGIN}/api/socket`, {
        headers: { cookie: tab.cookie!, host: "1ctx.test", origin: ORIGIN },
      }),
      "127.0.0.1",
      (data) => {
        captured = data as ConnData;
        return true;
      },
    );
    const closed: number[] = [];
    s.app.socket.open({
      data: captured!,
      send: (text) => text.length,
      close: (code) => closed.push(code ?? 1000),
    });
    s.secrets["user-ops"] = key("n");
    const start = s.app.now.value;
    const next = s.app.slept((at) => at > start + 60_000);
    s.app.now.value = start + 60_000;
    await next;
    expect(closed).toHaveLength(1);
    expect(logins(s.app)).toBe(1);
    expect(
      s.logs.events.find((e) => e.msg === "key logins ended")?.fields,
    ).toEqual({ logins: 1 });
    s.app.socket.dispose();
  });
});

describe("an admin key is no bearer", () => {
  test.each([
    ["POST", "/mcp"],
    ["GET", "/api/external-tasks"],
  ])("%s %s refuses it", async (method, path) => {
    const { app } = await setup();
    const res = await app.client().call(method, path, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      origin: null,
      ...(method === "POST"
        ? { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }
        : {}),
    });
    expect(res.status).toBe(401);
  });

  test("a key login's cookie does not open /mcp", async () => {
    const { app } = await setup();
    const tab = app.client();
    expect((await signIn(tab, ADMIN_KEY)).status).toBe(200);
    const res = await tab.call("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.status).toBe(401);
  });
});
