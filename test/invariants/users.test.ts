// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admin user writes keep identity, the personal project, access and logins
// coherent, while every response stays a projection without the hash.

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
    username === "caelea"
      ? "Oana Mangiurea"
      : `${username[0].toUpperCase()}${username.slice(1)}`,
  email: `${username}@example.com`,
  role: "member" as const,
  tz: "Europe/Bucharest",
  password: "longenough",
});

async function admin(app: TestApp): Promise<TestClient> {
  const client = app.client();
  expect((await client.login("admin", "hunter2-test")).status).toBe(200);
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
        ...userBody("caelea"),
        email: "CAELEA@EXAMPLE.COM",
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user.email).toBe("caelea@example.com");
    expect(user.disabled).toBe(false);
    expect(user.mustChangePassword).toBe(true);
    expect(app.users.byId(user.id)).toMatchObject({
      email: "caelea@example.com",
      about: "",
      disabled: false,
      mustChangePassword: true,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");
  });

  test("create accepts about and can leave the initial password usable", async () => {
    const app = await testApp();
    const client = await admin(app);
    const about = "First line.\nSecond line.";
    const response = await client.call("POST", "/api/users", {
      body: {
        ...userBody("robin"),
        about,
        disabled: false,
        mustChangePassword: false,
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user).toMatchObject({
      disabled: false,
      mustChangePassword: false,
    });
    expect(app.users.byId(user.id)).toMatchObject({
      about,
      disabled: false,
      mustChangePassword: false,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");

    const member = app.client();
    const login = await member.login("robin", "longenough");
    expect(login.status).toBe(200);
    expect((await login.json()).user.mustChangePassword).toBe(false);
    expect((await member.call("GET", "/api/projects")).status).toBe(200);
    const profile = await member.call("GET", "/api/profile");
    expect((await profile.json()).user.about).toBe(about);

    const reset = await client.call("POST", `/api/users/${user.id}/password`, {
      body: { password: "new-password" },
    });
    expect(reset.status).toBe(204);
    expect(app.users.byId(user.id)?.mustChangePassword).toBe(true);
  });

  test("create can disable an account before any login", async () => {
    const app = await testApp();
    const client = await admin(app);
    const response = await client.call("POST", "/api/users", {
      body: {
        ...userBody("robin"),
        about: "Unavailable.",
        disabled: true,
        mustChangePassword: false,
      },
    });
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user.disabled).toBe(true);
    expect(app.users.byId(user.id)).toMatchObject({
      about: "Unavailable.",
      disabled: true,
      mustChangePassword: false,
    });
    expect(app.projects.personal(user.id)?.name).toBe("personal");
    const member = app.client();
    expect((await member.login("robin", "longenough")).status).toBe(401);
    expect(member.cookie).toBeNull();
    expect((await member.call("GET", "/api/profile")).status).toBe(401);
  });

  test("create rolls back details and the personal project if disabling fails", async () => {
    const logs = collectLogs();
    const app = await testApp({ logFactory: logs.logFactory });
    const client = await admin(app);
    const original = app.users.setDisabled.bind(app.users);
    app.users.setDisabled = () => {
      throw new Error("disabled write failed");
    };
    try {
      const response = await client.call("POST", "/api/users", {
        body: {
          ...userBody("robin"),
          about: "Unavailable.",
          disabled: true,
          mustChangePassword: false,
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
          error: "disabled write failed",
        },
      });
    } finally {
      app.users.setDisabled = original;
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
      { mustChangePassword: null },
      { mustChangePassword: "false" },
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
    const missing = { ...userBody("caelea"), tz: undefined };
    expect(
      (await client.call("POST", "/api/users", { body: missing })).status,
    ).toBe(400);
    const user = await create(client, "caelea");
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
    const first = await create(client, "caelea");
    const second = await create(client, "elena");

    await expectConflict(
      await client.call("POST", "/api/users", {
        body: { ...userBody("caelea"), email: "other@example.com" },
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
    const user = await create(client, "caelea");
    const first = app.client();
    const second = app.client();
    await first.login("caelea", "longenough");
    await second.login("caelea", "longenough");
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
    const user = await create(client, "caelea");
    app.users.setDetails(user.id, { fullName: "Oana", about: "Actor." });

    const response = await client.call("PATCH", `/api/users/${user.id}`, {
      body: {
        username: user.username,
        fullName: "Oana Mangiurea",
        email: user.email,
      },
    });
    expect(response.status).toBe(200);
    expect(app.users.byId(user.id)).toMatchObject({
      username: "caelea",
      fullName: "Oana Mangiurea",
      email: "caelea@example.com",
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

  test("patch cannot set a password or change its initial requirement", async () => {
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

    const caller = await create(client, "caelea");
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
          fullName: "Oana",
          role: "admin",
          mustChangePassword: false,
          loginId: "stale",
        },
        params: { id: adminUser.id },
        url: new URL(request.url),
        address: "127.0.0.1",
      }),
    ).rejects.toThrow("last admin");
  });

  test.serial(
    "role changes publish access and update the socket project set",
    async () => {
      const app = await testApp();
      const client = await admin(app);
      const user = await create(client, "caelea");
      app.users.setMustChangePassword(user.id, false);
      const member = app.client();
      await member.login("caelea", "longenough");
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
          live: null,
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

  test("reset revokes every login and closes the user's socket", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "caelea");
    const first = app.client();
    const second = app.client();
    await first.login("caelea", "longenough");
    await second.login("caelea", "longenough");
    const conn = await connection(app, first);
    app.socket.open(conn);

    const response = await client.call(
      "POST",
      `/api/users/${user.id}/password`,
      { body: { password: "new-password" } },
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
    expect((await app.client().login("caelea", "new-password")).status).toBe(
      200,
    );
  });

  test("an admin resets their own password only from the profile", async () => {
    const app = await testApp();
    const client = await admin(app);
    const id = app.users.byUsername("admin")!.id;
    await expectConflict(
      await client.call("POST", `/api/users/${id}/password`, {
        body: { password: "new-password" },
      }),
      "own password",
    );
  });

  test("list, create and patch responses never carry a password hash", async () => {
    const app = await testApp();
    const client = await admin(app);
    const created = await client.call("POST", "/api/users", {
      body: userBody("caelea"),
    });
    const user = (await created.clone().json()).user;
    const responses = [
      created,
      await client.call("GET", "/api/users"),
      await client.call("PATCH", `/api/users/${user.id}`, {
        body: { fullName: "Oana Mangiurea" },
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
    const login = await client.login("admin", "hunter2-test");
    expect((await login.json()).user).not.toHaveProperty("email");
    const me = await client.call("GET", "/api/me");
    expect((await me.json()).user).not.toHaveProperty("email");
  });

  test("a project member summary carries no email", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "caelea");
    app.users.setMustChangePassword(user.id, false);
    const member = app.client();
    await member.login("caelea", "longenough");
    const project = app.projects.personal(user.id)!;
    const response = await member.call("GET", `/api/projects/${project.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.members[0]).toEqual({
      id: user.id,
      username: "caelea",
      fullName: "Oana Mangiurea",
      role: "member",
    });
    expect(body.project.members[0]).not.toHaveProperty("email");
  });
});

describe("disabled accounts", () => {
  test("disabling revokes open access and enabling restores sign-in", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "caelea");
    const first = app.client();
    const second = app.client();
    expect((await first.login("caelea", "longenough")).status).toBe(200);
    expect((await second.login("caelea", "longenough")).status).toBe(200);
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
    const refused = await app.client().login("caelea", "longenough");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "wrong username or password",
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
    expect((await app.client().login("caelea", "longenough")).status).toBe(200);
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
          mustChangePassword: false,
          loginId: "stale",
        },
        params: { id: bootstrap.id },
        url: new URL(request.url),
        address: "127.0.0.1",
      });
    };
    const outsider = { id: "other", username: "other" };
    await expect(callAs(outsider, { disabled: true })).rejects.toThrow(
      "last admin",
    );
    await expect(callAs(outsider, { role: "member" })).rejects.toThrow(
      "last admin",
    );

    const second = await create(client, "caelea");
    expect(
      (
        await client.call("PATCH", `/api/users/${second.id}`, {
          body: { role: "admin" },
        })
      ).status,
    ).toBe(200);
    expect(app.users.countAdmins()).toBe(2);
    expect((await callAs(second, { disabled: true }))?.status).toBe(200);
    expect(app.users.countAdmins()).toBe(1);
    expect((await callAs(second, { disabled: false }))?.status).toBe(200);
    expect((await callAs(second, { role: "member" }))?.status).toBe(200);
    expect(app.users.countAdmins()).toBe(1);
  });
});

describe("required password changes", () => {
  test("admin-set passwords restrict the account until profile change", async () => {
    const app = await testApp();
    const client = await admin(app);
    const user = await create(client, "caelea");
    expect(app.users.byId(user.id)?.mustChangePassword).toBe(true);

    const member = app.client();
    const login = await member.login("caelea", "longenough");
    expect(login.status).toBe(200);
    expect((await login.json()).user.mustChangePassword).toBe(true);
    const forbidden = await member.call("GET", "/api/projects");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: "change your password first",
    });
    const profile = await member.call("GET", "/api/profile");
    expect(profile.status).toBe(200);
    expect((await profile.json()).user.mustChangePassword).toBe(true);
    expect((await member.call("POST", "/api/logout")).status).toBe(200);

    expect((await member.login("caelea", "longenough")).status).toBe(200);
    const changed = await member.call("POST", "/api/profile/password", {
      body: { current: "longenough", next: "changed-password" },
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).user.mustChangePassword).toBe(false);
    expect((await member.call("GET", "/api/projects")).status).toBe(200);
    const me = await member.call("GET", "/api/me");
    expect((await me.json()).user.mustChangePassword).toBe(false);

    const reset = await client.call("POST", `/api/users/${user.id}/password`, {
      body: { password: "reset-password" },
    });
    expect(reset.status).toBe(204);
    expect(app.users.byId(user.id)?.mustChangePassword).toBe(true);
    const afterReset = await app.client().login("caelea", "reset-password");
    expect(afterReset.status).toBe(200);
    expect((await afterReset.json()).user.mustChangePassword).toBe(true);
  });

  test("the bootstrap admin starts without a required change", async () => {
    const app = await testApp();
    expect(app.users.byUsername("admin")?.mustChangePassword).toBe(false);
    const client = app.client();
    const login = await client.login("admin", "hunter2-test");
    expect((await login.json()).user.mustChangePassword).toBe(false);
  });
});
