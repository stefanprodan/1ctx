// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admin user writes keep identity, the personal project, access and logins
// coherent, while every response stays a projection.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import type { RouteDescriptor } from "../../src/server/lib/http.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { Conn, ConnData } from "../../src/server/web/socket.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import {
  collectLogs,
  ORIGIN,
  type TestApp,
  type TestClient,
  testApp,
} from "../helpers/app.ts";

type FakeConn = Conn & {
  frames: SocketEvent[];
  closed: { code?: number; reason?: string }[];
};

const userBody = (username: string) => ({
  username,
  fullName:
    username === "casey"
      ? "Casey Doe"
      : `${username[0].toUpperCase()}${username.slice(1)}`,
  email: `${username}@example.com`,
  role: "member" as const,
  tz: "Europe/Bucharest",
});

async function admin(app: TestApp): Promise<TestClient> {
  const client = app.client();
  expect((await client.signIn("admin")).status).toBe(200);
  return client;
}

async function create(client: TestClient, username: string) {
  const response = await client.call("POST", "/api/users", {
    body: userBody(username),
  });
  expect(response.status).toBe(201);
  return (await response.json()).user as {
    id: string;
    username: string;
    email: string;
  };
}

async function connection(app: TestApp, client: TestClient): Promise<FakeConn> {
  if (client.cookie === null) throw new Error("the client is not signed in");
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: {
      cookie: client.cookie,
      host: "1ctx.test",
      origin: ORIGIN,
    },
  });
  const outcome = await app.handle(req, "127.0.0.1", (data) => {
    captured = data as ConnData;
    return true;
  });
  expect(outcome).toBeUndefined();
  if (captured === null) throw new Error("the upgrade did not capture data");
  const conn: FakeConn = {
    data: captured,
    frames: [],
    closed: [],
    send(text) {
      conn.frames.push(JSON.parse(text));
      return text.length;
    },
    close(code, reason) {
      conn.closed.push({ code, reason });
    },
  };
  return conn;
}

async function expectConflict(response: Response, field: string) {
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain(field);
}

function userRoute(
  app: TestApp,
  method: string,
  path: string,
): RouteDescriptor {
  const route = app.routes.find((item) => {
    return item.method === method && item.path === path;
  });
  if (route === undefined) throw new Error(`${method} ${path} is not a route`);
  return route;
}

describe("admin users", () => {
  test("create stores a lowercase email with the personal project", async () => {
    const app = await testApp();
    const client = await admin(app);
    const response = await client.call("POST", "/api/users", {
      body: {
        ...userBody("casey"),
        email: "CASEY@EXAMPLE.COM",
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user.email).toBe("casey@example.com");
    expect(user.disabled).toBe(false);
    expect(user.signedInAt).toBeNull();
    expect(app.users.byId(user.id)).toMatchObject({
      email: "casey@example.com",
      about: "",
      disabled: false,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");
  });

  test("create accepts about, and the user signs in", async () => {
    const app = await testApp();
    const client = await admin(app);
    const about = "First line.\nSecond line.";
    const response = await client.call("POST", "/api/users", {
      body: {
        ...userBody("robin"),
        about,
        disabled: false,
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user).toMatchObject({
      disabled: false,
    });
    expect(app.users.byId(user.id)).toMatchObject({
      about,
      disabled: false,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");

    const member = app.client();
    const login = await member.signIn("robin");
    expect(login.status).toBe(200);
    expect((await member.call("GET", "/api/projects")).status).toBe(200);
    const profile = await member.call("GET", "/api/profile");
    expect((await profile.json()).user.about).toBe(about);
  });

  test("create can disable an account before any login", async () => {
    const app = await testApp();
    const client = await admin(app);
    const response = await client.call("POST", "/api/users", {
      body: {
        ...userBody("robin"),
        about: "Unavailable.",
        disabled: true,
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user.disabled).toBe(true);
    expect(app.users.byId(user.id)).toMatchObject({
      about: "Unavailable.",
      disabled: true,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");
    const member = app.client();
    expect((await member.signIn("robin")).status).toBe(401);
    expect(member.cookie).toBeNull();
    expect((await member.call("GET", "/api/profile")).status).toBe(401);
  });

  test("create rolls back the user if its personal project fails", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const client = await admin(app);
    const original = app.projects.createPersonal.bind(app.projects);
    app.projects.createPersonal = () => {
      throw new Error("personal project failed");
    };
    try {
      const response = await client.call("POST", "/api/users", {
        body: {
          ...userBody("robin"),
          about: "Unavailable.",
          disabled: true,
        },
      });
      expect(response.status).toBe(500);
      expect(
        logs.events.findLast((event) => event.level === "error"),
      ).toMatchObject({
        area: "router",
        msg: "request",
        fields: {
          route: "/api/users",
          status: 500,
          error: "personal project failed",
        },
      });
    } finally {
      app.projects.createPersonal = original;
    }
    expect(app.users.byUsername("robin")).toBeNull();
    expect(app.db.query("select count(*) as n from projects").get()).toEqual({
      n: 1,
    });
  });

  test("malformed optional fields are refused before a user is created", async () => {
    const app = await testApp();
    const client = await admin(app);
    for (const fields of [
      { about: null },
      { about: 1 },
      { disabled: null },
      { disabled: "false" },
      { password: "longenough" },
      { mustChangePassword: false },
    ]) {
      const response = await client.call("POST", "/api/users", {
        body: { ...userBody("robin"), ...fields },
      });
      expect(response.status).toBe(400);
      expect(app.users.byUsername("robin")).toBeNull();
    }
  });

  test("a user is made in the zone the admin picked, and the admin moves it", async () => {
    const app = await testApp();
    const client = await admin(app);
    const missing = { ...userBody("casey"), tz: undefined };
    expect(
      (await client.call("POST", "/api/users", { body: missing })).status,
    ).toBe(400);
    const user = await create(client, "casey");
    expect(app.users.byId(user.id)?.tz).toBe("Europe/Bucharest");
    const moved = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { tz: "Asia/Tokyo" },
    });
    expect(moved.status).toBe(200);
    expect((await moved.json()).user.tz).toBe("Asia/Tokyo");
    const bad = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { tz: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);
    expect(app.users.byId(user.id)?.tz).toBe("Asia/Tokyo");
    expect(app.users.byUsername("admin")?.tz).toBe("UTC");
  });

  test("create rolls the user back when its personal project fails", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const client = await admin(app);
    const original = app.projects.createPersonal.bind(app.projects);
    app.projects.createPersonal = () => {
      throw new Error("project write failed");
    };
    try {
      const response = await client.call("POST", "/api/users", {
        body: userBody("ghost"),
      });
      expect(response.status).toBe(500);
      expect(
        logs.events.findLast((event) => event.level === "error"),
      ).toMatchObject({
        area: "router",
        msg: "request",
        fields: {
          route: "/api/users",
          status: 500,
          error: "project write failed",
        },
      });
    } finally {
      app.projects.createPersonal = original;
    }
    expect(app.users.byUsername("ghost")).toBeNull();
  });

  test("taken identity fields answer field-specific conflicts", async () => {
    const app = await testApp();
    const client = await admin(app);
    const first = await create(client, "casey");
    const second = await create(client, "elena");

    await expectConflict(
      await client.call("POST", "/api/users", {
        body: { ...userBody("casey"), email: "other@example.com" },
      }),
      "username",
    );

    // a username no longer names a project, so a team's name is free
    const owner = app.users.byUsername("admin")!;
    app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values ('taken', 'team', 'maria', ?, 0)",
      )
      .run(owner.id);
    expect(
      (
        await client.call("POST", "/api/users", {
          body: { ...userBody("maria"), email: "maria@example.com" },
        })
      ).status,
    ).toBe(201);

    await expectConflict(
      await client.call("POST", "/api/users", {
        body: { ...userBody("ana"), email: first.email.toUpperCase() },
      }),
      "email",
    );

    await expectConflict(
      await client.call("PATCH", `/api/users/${second.id}`, {
        body: { username: first.username },
      }),
      "username",
    );
    await expectConflict(
      await client.call("PATCH", `/api/users/${second.id}`, {
        body: { username: "maria" },
      }),
      "username",
    );
    await expectConflict(
      await client.call("PATCH", `/api/users/${second.id}`, {
        body: { email: first.email.toUpperCase() },
      }),
      "email",
    );
  });

  test("rename leaves the personal project and keeps every login", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "casey");
    const first = app.client();
    const second = app.client();
    await first.signIn("casey");
    await second.signIn("casey");
    const before = app.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from logins where user_id = ?",
      )
      .get(user.id)!.n;

    const response = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { username: "maria" },
    });
    expect(response.status).toBe(200);
    expect(app.projects.personal(user.id)?.name).toBe("personal");
    expect(
      app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from logins where user_id = ?",
        )
        .get(user.id)!.n,
    ).toBe(before);
    expect((await first.call("GET", "/api/me")).status).toBe(200);
    expect((await second.call("GET", "/api/me")).status).toBe(200);
  });

  test("same identity values are accepted and a full name keeps about", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "casey");
    app.users.setDetails(user.id, { fullName: "Casey", about: "Actor." });

    const response = await client.call("PATCH", `/api/users/${user.id}`, {
      body: {
        username: user.username,
        fullName: "Casey Doe",
        email: user.email,
      },
    });
    expect(response.status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      username: "casey",
      fullName: "Casey Doe",
      email: "casey@example.com",
      about: "Actor.",
    });
  });

  test("patch updates full name and about together and preserves omitted details", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "robin");
    const patch = (body: { fullName?: string; about?: string }) =>
      client.call("PATCH", `/api/users/${user.id}`, { body });

    const combined = await patch({
      fullName: "Robin Example",
      about: "First line.",
    });
    expect(combined.status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      fullName: "Robin Example",
      about: "First line.",
    });
    expect((await patch({ about: "Second line." })).status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      fullName: "Robin Example",
      about: "Second line.",
    });
    expect((await patch({ fullName: "Robin Sample" })).status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      fullName: "Robin Sample",
      about: "Second line.",
    });
    expect((await patch({ about: "" })).status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      fullName: "Robin Sample",
      about: "",
    });
  });

  test("patch takes no password", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "robin");
    const before = app.users.byId(user.id);
    for (const body of [
      { about: "Changed.", password: "new-password" },
      { about: "Changed.", mustChangePassword: false },
    ]) {
      const response = await client.call("PATCH", `/api/users/${user.id}`, {
        body,
      });
      expect(response.status).toBe(400);
      expect(app.users.byId(user.id)).toEqual(before);
    }
  });

  test("a refused own-account change rolls back full name and about", async () => {
    const app = await testApp();
    const client = await admin(app);
    const before = app.users.byUsername("admin")!;
    for (const change of [{ role: "member" }, { disabled: true }]) {
      const response = await client.call("PATCH", `/api/users/${before.id}`, {
        body: { ...change, fullName: "Other Name", about: "Changed." },
      });
      expect(response.status).toBe(409);
      expect(app.users.byId(before.id)).toEqual(before);
    }
  });

  test("own role and the last admin role are conflicts", async () => {
    const app = await testApp();
    const client = await admin(app);
    const adminUser = app.users.byUsername("admin")!;
    await expectConflict(
      await client.call("PATCH", `/api/users/${adminUser.id}`, {
        body: { role: "member" },
      }),
      "role",
    );

    const caller = await create(client, "casey");
    const route = userRoute(app, "PATCH", "/api/users/:id");
    const request = new Request(`${ORIGIN}/api/users/${adminUser.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });
    await expect(
      route.handle(request, {
        principal: {
          userId: caller.id,
          username: caller.username,
          fullName: "Casey",
          role: "admin",
          via: { kind: "login", id: "stale" },
        },
        params: { id: adminUser.id },
        url: new URL(request.url),
        address: "127.0.0.1",
      }),
      // a caller without a live admin login is refused before any guard
    ).rejects.toThrow("sign in");
    expect(app.users.byId(adminUser.id)!.role).toBe("admin");
  });

  test.serial(
    "role changes publish access and update the socket project set",
    async () => {
      const app = await testApp();
      const client = await admin(app);
      const user = await create(client, "casey");
      const member = app.client();
      await member.signIn("casey");
      const owner = app.users.byUsername("admin")!;
      app.db
        .query(
          "insert into projects (id, kind, name, owner_id, created_at) values ('team', 'team', 'team', ?, 0)",
        )
        .run(owner.id);
      app.db.exec(`
      insert into providers
        (id, name, wire, base_url, key_name, created_at)
      values
        ('provider', 'provider', 'openai-compatible', 'http://models.test', null, 0);
      insert into agents
        (id, name, avatar, provider_id, model, model_name, context_length,
         prompt_price, completion_price, tools, reasoning, prompt, created_at)
      values
        ('agent', 'agent', 'bot', 'provider', 'model', 'Model', null,
         null, null, 0, 0, '', 0);
    `);
      const chat = app.sessions.create({
        projectId: "team",
        ownerId: user.id,
        agentId: "agent",
        title: "Chat",
        now: 0,
      });
      const conn = await connection(app, member);
      app.socket.open(conn);
      expect(conn.data.projects.has("team")).toBe(false);
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => seen.push(event), silent);
      try {
        const promoted = await client.call("PATCH", `/api/users/${user.id}`, {
          body: { role: "admin" },
        });
        expect(promoted.status).toBe(200);
        expect(conn.data.projects.has("team")).toBe(true);
        expect(conn.data.principal.role).toBe("admin");
        expect(conn.frames).toContainEqual({ type: "role", role: "admin" });
        conn.frames = [];
        app.socket.message(
          conn,
          JSON.stringify({ type: "watch", sessionId: chat.id }),
        );
        expect(conn.frames).toContainEqual({
          type: "watched",
          sessionId: chat.id,
          live: [],
          queue: { revision: expect.any(Number), rows: [] },
        });
        expect(seen).toContainEqual({
          type: "access.changed",
          data: { userIds: [user.id] },
        });

        conn.frames = [];
        const demoted = await client.call("PATCH", `/api/users/${user.id}`, {
          body: { role: "member" },
        });
        expect(demoted.status).toBe(200);
        expect(conn.data.projects.has("team")).toBe(false);
        expect(conn.data.principal.role).toBe("member");
        expect(conn.frames).toContainEqual({ type: "role", role: "member" });
        expect(conn.frames).toContainEqual({
          type: "revoked",
          projectId: "team",
        });
      } finally {
        stop();
        app.socket.close(conn);
      }
    },
  );

  test("sign out everywhere ends every login and closes the user's socket", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "casey");
    const first = app.client();
    const second = app.client();
    await first.signIn("casey");
    await second.signIn("casey");
    const conn = await connection(app, first);
    app.socket.open(conn);

    const response = await client.call(
      "POST",
      `/api/users/${user.id}/sign-out`,
    );
    expect(response.status).toBe(204);
    expect(
      app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from logins where user_id = ?",
        )
        .get(user.id),
    ).toEqual({ n: 0 });
    expect(conn.closed).toEqual([{ code: 4001, reason: "signed out" }]);
    expect((await first.call("GET", "/api/profile")).status).toBe(401);
    expect((await second.call("GET", "/api/profile")).status).toBe(401);
    // the admin's own login stays
    expect((await client.call("GET", "/api/profile")).status).toBe(200);
  });

  test("an admin cannot sign themself out everywhere", async () => {
    const app = await testApp();
    const client = await admin(app);
    const id = app.users.byUsername("admin")!.id;
    await expectConflict(
      await client.call("POST", `/api/users/${id}/sign-out`),
      "sign yourself out",
    );
  });

  test("list, create and patch responses never carry a password hash", async () => {
    const app = await testApp();
    const client = await admin(app);
    const created = await client.call("POST", "/api/users", {
      body: userBody("casey"),
    });
    const user = (await created.clone().json()).user;
    const responses = [
      created,
      await client.call("GET", "/api/users"),
      await client.call("PATCH", `/api/users/${user.id}`, {
        body: { fullName: "Casey Doe" },
      }),
      await client.call("GET", "/api/profile"),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain("passwordHash");
      expect(text).not.toContain("$argon2");
    }
  });

  test("list is sorted by username", async () => {
    const app = await testApp();
    const client = await admin(app);
    await create(client, "zed");
    await create(client, "alice");
    const response = await client.call("GET", "/api/users");
    const body = await response.json();
    expect(
      body.users.map((user: { username: string }) => user.username),
    ).toEqual(["admin", "alice", "zed"]);
  });
});

describe("user email projections", () => {
  test("the bootstrap admin has the fixed email", async () => {
    const app = await testApp();
    expect(app.users.byUsername("admin")?.email).toBe("admin@1ctx.dev");
    const client = await admin(app);
    const profile = await (await client.call("GET", "/api/profile")).json();
    expect(profile.user.email).toBe("admin@1ctx.dev");
  });

  test("login and me keep the email private", async () => {
    const app = await testApp();
    const client = app.client();
    const login = await client.signIn("admin");
    expect((await login.json()).user).not.toHaveProperty("email");
    const me = await client.call("GET", "/api/me");
    expect((await me.json()).user).not.toHaveProperty("email");
  });

  test("a project member summary carries no email", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "casey");
    const member = app.client();
    await member.signIn("casey");
    const project = app.projects.personal(user.id)!;
    const response = await member.call("GET", `/api/projects/${project.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.members[0]).toEqual({
      id: user.id,
      username: "casey",
      fullName: "Casey Doe",
      role: "member",
    });
    expect(body.project.members[0]).not.toHaveProperty("email");
  });
});

describe("disabled accounts", () => {
  test("disabling revokes open access and enabling restores sign-in", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "casey");
    const first = app.client();
    const second = app.client();
    expect((await first.signIn("casey")).status).toBe(200);
    expect((await second.signIn("casey")).status).toBe(200);
    const conn = await connection(app, first);
    app.socket.open(conn);

    const disabled = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).user.disabled).toBe(true);
    expect(app.users.byId(user.id)?.disabled).toBe(true);
    expect(
      app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from logins where user_id = ?",
        )
        .get(user.id),
    ).toEqual({ n: 0 });
    expect(conn.closed).toEqual([{ code: 4001, reason: "signed out" }]);
    expect((await first.call("GET", "/api/profile")).status).toBe(401);
    const refused = await app.client().signIn("casey");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "sign in",
    });

    const again = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { disabled: true },
    });
    expect(again.status).toBe(200);

    const enabled = await client.call("PATCH", `/api/users/${user.id}`, {
      body: { disabled: false },
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).user.disabled).toBe(false);
    expect((await app.client().signIn("casey")).status).toBe(200);
  });

  test("the caller and last enabled admin guards preserve an administrator", async () => {
    const app = await testApp();
    const client = await admin(app);
    const bootstrap = app.users.byUsername("admin")!;
    await expectConflict(
      await client.call("PATCH", `/api/users/${bootstrap.id}`, {
        body: { disabled: true },
      }),
      "own account",
    );

    const route = userRoute(app, "PATCH", "/api/users/:id");
    const callAs = async (
      caller: { id: string; username: string },
      body: { role?: "member"; disabled?: boolean },
      login = "stale",
    ) => {
      const request = new Request(`${ORIGIN}/api/users/${bootstrap.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return route.handle(request, {
        principal: {
          userId: caller.id,
          username: caller.username,
          fullName: caller.username,
          role: "admin",
          via: { kind: "login", id: login },
        },
        params: { id: bootstrap.id },
        url: new URL(request.url),
        address: "127.0.0.1",
      });
    };
    // a caller without a live admin login is refused before any guard
    const outsider = { id: "other", username: "other" };
    await expect(callAs(outsider, { disabled: true })).rejects.toThrow(
      "sign in",
    );
    await expect(callAs(outsider, { role: "member" })).rejects.toThrow(
      "sign in",
    );

    const second = await create(client, "casey");
    expect(
      (
        await client.call("PATCH", `/api/users/${second.id}`, {
          body: { role: "admin" },
        })
      ).status,
    ).toBe(200);
    expect(app.users.countAdmins()).toBe(2);
    expect((await app.client().signIn("casey")).status).toBe(200);
    const login = app.db
      .query<{ id: string }, [string]>(
        "select id from logins where user_id = ?",
      )
      .get(second.id)!.id;
    const as = (body: { role?: "member"; disabled?: boolean }) =>
      callAs(second, body, login);
    expect((await as({ disabled: true }))?.status).toBe(200);
    expect(app.users.countAdmins()).toBe(1);
    expect((await as({ disabled: false }))?.status).toBe(200);
    expect((await as({ role: "member" }))?.status).toBe(200);
    expect(app.users.countAdmins()).toBe(1);
  });
});
