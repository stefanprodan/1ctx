// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user is made with its personal project in one transaction, the
// project routes list what the caller may see, and a personal project
// is a 404 to everyone else, an admin included.

import { describe, expect, test } from "bun:test";
import { hashPassword } from "../../src/server/users/index.ts";
import { testApp } from "../helpers/app.ts";

const member = async (app: Awaited<ReturnType<typeof testApp>>) =>
  app.createUser({
    username: "oana",
    fullName: "Oana Pellea",
    email: "oana@example.com",
    role: "member",
    passwordHash: await hashPassword("hunter2-test"),
    mustChangePassword: false,
    now: app.now.value,
  });

describe("the personal project", () => {
  test("is made with the user, named after them, with them as the member", async () => {
    const app = await testApp();
    const admin = app.users.byUsername("admin")!;
    const project = app.projects.personal(admin.id);
    expect(project).toMatchObject({
      kind: "personal",
      name: "admin",
      ownerId: admin.id,
      createdAt: admin.createdAt,
    });
    expect(app.projects.isMember(project!.id, admin.id)).toBe(true);
    const oana = await member(app);
    expect(app.projects.personal(oana.id)?.name).toBe("oana");
  });

  test("a user is never made without it", async () => {
    const app = await testApp();
    // a second personal project for the same owner breaks the index,
    // so the user that would own it is rolled back with it
    const admin = app.users.byUsername("admin")!;
    expect(() =>
      app.db.transaction(() => {
        app.projects.createPersonal({
          userId: admin.id,
          name: "again",
          now: 0,
        });
      })(),
    ).toThrow();
    const before = app.users.count();
    const store = app.projects;
    const original = store.createPersonal.bind(store);
    store.createPersonal = () => {
      throw new Error("no project");
    };
    try {
      expect(() =>
        app.createUser({
          username: "ghost",
          fullName: "Ghost",
          email: "ghost@example.com",
          role: "member",
          passwordHash: "x",
          mustChangePassword: false,
          now: 0,
        }),
      ).toThrow("no project");
    } finally {
      store.createPersonal = original;
    }
    expect(app.users.count()).toBe(before);
    expect(app.users.byUsername("ghost")).toBeNull();
  });

  test("goes with the user", async () => {
    const app = await testApp();
    const oana = await member(app);
    const project = app.projects.personal(oana.id)!;
    app.db.query("delete from users where id = ?").run(oana.id);
    expect(app.projects.byId(project.id)).toBeNull();
    expect(app.projects.memberIds(project.id)).toEqual([]);
  });
});

describe("GET /api/projects", () => {
  test("lists the caller's projects, the personal one first", async () => {
    const app = await testApp();
    const admin = app.users.byUsername("admin")!;
    // two team projects the admin is a member of, named to sort before
    // the personal one and before each other
    for (const [id, name] of [
      ["t-zed", "zed"],
      ["t-aa", "aa"],
    ]) {
      app.db
        .query(
          "insert into projects (id, kind, name, owner_id, created_at) values (?, 'team', ?, ?, 0)",
        )
        .run(id, name, admin.id);
      app.db
        .query(
          "insert into memberships (project_id, user_id, created_at) values (?, ?, 0)",
        )
        .run(id, admin.id);
    }
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const res = await client.call("GET", "/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [
        { id: expect.any(String), kind: "personal", name: "admin" },
        { id: "t-aa", kind: "team", name: "aa" },
        { id: "t-zed", kind: "team", name: "zed" },
      ],
    });
  });
});

describe("GET /api/projects/:id", () => {
  test("answers the caller's own project with its members", async () => {
    const app = await testApp();
    const client = app.client();
    await client.login("admin", "hunter2-test");
    const admin = app.users.byUsername("admin")!;
    const project = app.projects.personal(admin.id)!;
    const res = await client.call("GET", `/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      project: {
        id: project.id,
        kind: "personal",
        name: "admin",
        createdAt: admin.createdAt,
        members: [
          {
            id: admin.id,
            username: "admin",
            fullName: "Administrator",
            role: "admin",
          },
        ],
      },
    });
  });

  test("another user's personal project is a 404, for an admin too", async () => {
    const app = await testApp();
    const oana = await member(app);
    const project = app.projects.personal(oana.id)!;
    const admin = app.client();
    await admin.login("admin", "hunter2-test");
    const res = await admin.call("GET", `/api/projects/${project.id}`);
    expect(res.status).toBe(404);
    const missing = await admin.call("GET", "/api/projects/nothing");
    expect(missing.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
    const her = app.client();
    await her.login("oana", "hunter2-test");
    expect((await her.call("GET", `/api/projects/${project.id}`)).status).toBe(
      200,
    );
  });
});
