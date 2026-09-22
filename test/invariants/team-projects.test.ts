// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { Conn, ConnData } from "../../src/server/web/socket.ts";
import type { ProjectDetail } from "../../src/shared/contracts/project.ts";
import type { SocketEvent } from "../../src/shared/socket.ts";
import { hashPassword, ORIGIN, type TestClient } from "../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

type FakeConn = Conn & {
  frames: SocketEvent[];
  closed: { code?: number; reason?: string }[];
};
async function connection(
  chat: ChatApp,
  client: TestClient,
): Promise<FakeConn> {
  if (client.cookie === null) throw new Error("the client is not signed in");
  let captured: ConnData | null = null;
  const req = new Request(`${ORIGIN}/api/socket`, {
    headers: {
      cookie: client.cookie,
      host: "1ctx.test",
      origin: ORIGIN,
    },
  });
  const outcome = await chat.app.handle(req, "127.0.0.1", (data) => {
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
async function makeUser(
  chat: ChatApp,
  username: string,
  role: "admin" | "member" = "member",
) {
  const user = chat.app.createUser({
    username,
    fullName: username.toUpperCase(),
    email: `${username}@example.com`,
    role,
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: chat.app.now.value,
  });
  const client = chat.app.client();
  await client.login(username, "pw");
  return { user, client };
}
async function createTeam(chat: ChatApp, name: string): Promise<ProjectDetail> {
  const res = await chat.admin.call("POST", "/api/projects", {
    body: { name },
  });
  expect(res.status).toBe(201);
  return (await res.json()).project;
}
async function addMember(chat: ChatApp, projectId: string, userId: string) {
  const res = await chat.admin.call(
    "POST",
    `/api/projects/${projectId}/members`,
    { body: { userId } },
  );
  expect(res.status).toBe(201);
  return (await res.json()).project as ProjectDetail;
}
async function finish(chat: ChatApp, script: Script) {
  script.reply("done");
  for (let i = 0; i < 200; i++) {
    if (chat.app.runner.registry.size === 0) return;
    await tick();
  }
  throw new Error("the send did not finish");
}
function count(
  chat: ChatApp,
  table: "sessions" | "messages" | "sends" | "usage",
  column: "project_id" | "session_id",
  id: string,
): number {
  return chat.app.db
    .query<{ n: number }, [string]>(
      `select count(*) as n from ${table} where ${column} = ?`,
    )
    .get(id)!.n;
}
function close(chat: ChatApp, ...connections: FakeConn[]) {
  for (const conn of connections) chat.app.socket.close(conn);
  chat.app.socket.dispose();
}
describe("team project administration", () => {
  test("a member is forbidden from every project write", async () => {
    const chat = await chatApp();
    const project = await createTeam(chat, "ops");
    const calls = [
      chat.member.call("POST", "/api/projects", { body: { name: "mine" } }),
      chat.member.call("PATCH", `/api/projects/${project.id}`, {
        body: { name: "other" },
      }),
      chat.member.call("DELETE", `/api/projects/${project.id}`),
      chat.member.call("POST", `/api/projects/${project.id}/members`, {
        body: { userId: chat.memberId },
      }),
      chat.member.call(
        "DELETE",
        `/api/projects/${project.id}/members/${chat.memberId}`,
      ),
    ];
    expect((await Promise.all(calls)).map((res) => res.status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
    chat.app.socket.dispose();
  });
  test("a personal project is hidden from every project mutation", async () => {
    const chat = await chatApp();
    const personal = chat.app.projects.personal(chat.adminId)!;
    const calls = [
      chat.admin.call("PATCH", `/api/projects/${personal.id}`, {
        body: { name: "private" },
      }),
      chat.admin.call("DELETE", `/api/projects/${personal.id}`),
      chat.admin.call("POST", `/api/projects/${personal.id}/members`, {
        body: { userId: chat.memberId },
      }),
      chat.admin.call(
        "DELETE",
        `/api/projects/${personal.id}/members/${chat.adminId}`,
      ),
      chat.admin.call("PATCH", `/api/projects/${personal.id}`, {
        body: { unexpected: true },
      }),
      chat.admin.call("POST", `/api/projects/${personal.id}/members`, {
        body: { unexpected: true },
      }),
    ];
    const responses = await Promise.all(calls);
    expect(responses.map((res) => res.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(await responses[0].json()).toEqual({ error: "no such project" });
    chat.app.socket.dispose();
  });
  test("names and memberships report their field conflicts", async () => {
    const chat = await chatApp();
    // every personal project is named personal, so a team may not be
    const reserved = await chat.admin.call("POST", "/api/projects", {
      body: { name: "personal" },
    });
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toEqual({ error: "name is taken" });
    // a username names no project any more
    expect((await createTeam(chat, "caelea")).name).toBe("caelea");
    expect((await createTeam(chat, "on_call")).name).toBe("on_call");
    expect((await createTeam(chat, "a".repeat(80))).name).toHaveLength(80);
    for (const name of ["on.call", "On-call", "a".repeat(81)]) {
      const refused = await chat.admin.call("POST", "/api/projects", {
        body: { name },
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe(
        "name must be 2 to 80 lowercase letters, digits, dashes and underscores",
      );
    }
    const ops = await createTeam(chat, "ops");
    expect(
      (
        await chat.admin.call("POST", "/api/projects", {
          body: { name: "ops" },
        })
      ).status,
    ).toBe(409);
    const same = await chat.admin.call("PATCH", `/api/projects/${ops.id}`, {
      body: { name: "ops" },
    });
    expect(same.status).toBe(200);
    expect((await same.json()).project.name).toBe("ops");
    const other = await createTeam(chat, "other");
    expect(
      (
        await chat.admin.call("PATCH", `/api/projects/${other.id}`, {
          body: { name: "ops" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await chat.admin.call("PATCH", `/api/projects/${other.id}`, {
          body: { name: "personal" },
        })
      ).status,
    ).toBe(409);
    const unknown = await chat.admin.call(
      "POST",
      `/api/projects/${ops.id}/members`,
      { body: { userId: "missing" } },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "userId does not name a user",
    });
    await addMember(chat, ops.id, chat.memberId);
    const duplicate = await chat.admin.call(
      "POST",
      `/api/projects/${ops.id}/members`,
      { body: { userId: chat.memberId } },
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "userId is already a member",
    });
    expect(
      (
        await chat.admin.call(
          "DELETE",
          `/api/projects/${ops.id}/members/${chat.memberId}`,
        )
      ).status,
    ).toBe(200);
    const absent = await chat.admin.call(
      "DELETE",
      `/api/projects/${ops.id}/members/${chat.memberId}`,
    );
    expect(absent.status).toBe(409);
    expect(await absent.json()).toEqual({
      error: "userId is not a member",
    });
    const missing = await chat.admin.call(
      "DELETE",
      `/api/projects/${ops.id}/members/missing`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "userId does not name a user",
    });
    chat.app.socket.dispose();
  });
  test("a description is set on create, changed alone, and checked", async () => {
    const chat = await chatApp();
    const made = await chat.admin.call("POST", "/api/projects", {
      body: { name: "ops", description: "Incidents and pages" },
    });
    expect(made.status).toBe(201);
    const ops: ProjectDetail = (await made.json()).project;
    expect(ops.description).toBe("Incidents and pages");
    expect((await createTeam(chat, "other")).description).toBe("");
    const changed = await chat.admin.call("PATCH", `/api/projects/${ops.id}`, {
      body: { description: "" },
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).project).toMatchObject({
      name: "ops",
      description: "",
    });
    for (const description of [" padded", "two\nlines", "x".repeat(281), 7]) {
      const bad = await chat.admin.call("PATCH", `/api/projects/${ops.id}`, {
        body: { description },
      });
      expect(bad.status).toBe(400);
    }
    const empty = await chat.admin.call("PATCH", `/api/projects/${ops.id}`, {
      body: {},
    });
    expect(empty.status).toBe(400);
    chat.app.socket.dispose();
  });

  test("a chat in a team project tells the agent its description", async () => {
    const chat = await chatApp();
    const made = await chat.admin.call("POST", "/api/projects", {
      body: { name: "ops", description: "Incidents and pages" },
    });
    const ops: ProjectDetail = (await made.json()).project;
    await addMember(chat, ops.id, chat.memberId);
    const { script } = await startChat(chat, "hi", chat.member, ops.id);
    const messages = script.body.messages as {
      role: string;
      content: string;
    }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain(
      "You work in the ops project: Incidents and pages",
    );
    await finish(chat, script);
    chat.app.socket.dispose();
  });

  test("the list follows visibility and keeps the personal project first", async () => {
    const chat = await chatApp();
    const second = await makeUser(chat, "stefan", "admin");
    const project = await createTeam(chat, "ops");
    const response = await second.client.call("GET", "/api/projects");
    expect(response.status).toBe(200);
    const { projects } = await response.json();
    expect(projects).toEqual([
      {
        id: chat.app.projects.personal(second.user.id)!.id,
        kind: "personal",
        name: "personal",
        createdAt: expect.any(Number),
        memberCount: 1,
      },
      {
        id: project.id,
        kind: "team",
        name: "ops",
        createdAt: expect.any(Number),
        memberCount: 0,
      },
    ]);
    // the admin sees their own personal project, never the member's
    expect(
      projects.filter((item: { kind: string }) => item.kind === "personal"),
    ).toHaveLength(1);
    const memberList = await (
      await chat.member.call("GET", "/api/projects")
    ).json();
    expect(memberList.projects).toEqual([
      {
        id: chat.projectId,
        kind: "personal",
        name: "personal",
        createdAt: expect.any(Number),
        memberCount: 1,
      },
    ]);
    chat.app.socket.dispose();
  });
  test.serial(
    "membership changes publish and grant then revoke the project",
    async () => {
      const chat = await chatApp();
      const project = await createTeam(chat, "ops");
      const conn = await connection(chat, chat.member);
      chat.app.socket.open(conn);
      conn.frames = [];
      const events: BusEvent[] = [];
      const off = subscribe((event) => events.push(event), silent);
      const added = await addMember(chat, project.id, chat.memberId);
      expect(added.members.map((user) => user.id)).toEqual([chat.memberId]);
      expect(events).toEqual([
        {
          type: "access.changed",
          data: { userIds: [chat.memberId] },
        },
      ]);
      expect(conn.frames).toEqual([{ type: "granted", projectId: project.id }]);
      events.length = 0;
      conn.frames = [];
      const removed = await chat.admin.call(
        "DELETE",
        `/api/projects/${project.id}/members/${chat.memberId}`,
      );
      expect(removed.status).toBe(200);
      expect(events).toEqual([
        {
          type: "access.changed",
          data: { userIds: [chat.memberId] },
        },
      ]);
      expect(conn.frames).toEqual([{ type: "revoked", projectId: project.id }]);
      off();
      close(chat, conn);
    },
  );
  test("create and delete move every admin without membership rows", async () => {
    const chat = await chatApp();
    const second = await makeUser(chat, "stefan", "admin");
    const conn = await connection(chat, second.client);
    chat.app.socket.open(conn);
    conn.frames = [];
    const project = await createTeam(chat, "ops");
    expect(chat.app.projects.isMember(project.id, second.user.id)).toBe(false);
    expect(conn.frames).toEqual([{ type: "granted", projectId: project.id }]);
    conn.frames = [];
    const deleted = await chat.admin.call(
      "DELETE",
      `/api/projects/${project.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 0 });
    expect(conn.frames).toEqual([{ type: "revoked", projectId: project.id }]);
    close(chat, conn);
  });
  test.serial("adding an admin member emits no visibility frame", async () => {
    const chat = await chatApp();
    const second = await makeUser(chat, "stefan", "admin");
    const project = await createTeam(chat, "ops");
    const conn = await connection(chat, second.client);
    chat.app.socket.open(conn);
    conn.frames = [];
    const events: BusEvent[] = [];
    const off = subscribe((event) => events.push(event), silent);
    await addMember(chat, project.id, second.user.id);
    expect(events).toEqual([
      {
        type: "access.changed",
        data: { userIds: [second.user.id] },
      },
    ]);
    expect(conn.frames).toEqual([]);
    off();
    close(chat, conn);
  });
});
describe("team project chat lifecycle", () => {
  test("project deletion removes every chat row and its usage", async () => {
    const chat = await chatApp();
    const project = await createTeam(chat, "ops");
    await addMember(chat, project.id, chat.memberId);
    const started = await startChat(chat, "team chat", chat.member, project.id);
    await finish(chat, started.script);
    expect(count(chat, "sessions", "project_id", project.id)).toBe(1);
    expect(count(chat, "messages", "session_id", started.sessionId)).toBe(2);
    expect(count(chat, "sends", "session_id", started.sessionId)).toBe(1);
    expect(count(chat, "usage", "session_id", started.sessionId)).toBe(1);
    const detail = await (
      await chat.admin.call("GET", `/api/projects/${project.id}`)
    ).json();
    expect(detail.project.chats).toBe(1);
    const deleted = await chat.admin.call(
      "DELETE",
      `/api/projects/${project.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(count(chat, "sessions", "project_id", project.id)).toBe(0);
    expect(count(chat, "messages", "session_id", started.sessionId)).toBe(0);
    expect(count(chat, "sends", "session_id", started.sessionId)).toBe(0);
    expect(count(chat, "usage", "session_id", started.sessionId)).toBe(0);
    chat.app.socket.dispose();
  });
  test("project deletion refuses a running send admitted in the same tick", async () => {
    const chat = await chatApp();
    const project = await createTeam(chat, "ops");
    await addMember(chat, project.id, chat.memberId);
    const pending = chat.scripted.next();
    const detail = chat.app.runner.start(
      {
        userId: chat.memberId,
        username: "caelea",
        fullName: "Oana Mangiurea",
        role: "member",
        mustChangePassword: false,
        loginId: "test",
      },
      { projectId: project.id, agentId: chat.agentId, message: "hello" },
    );
    const refused = await chat.admin.call(
      "DELETE",
      `/api/projects/${project.id}`,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "project has a running chat",
    });
    expect(chat.app.sessions.byId(detail.session.id)?.status).toBe("running");
    await finish(chat, await pending);
    chat.app.socket.dispose();
  });
  test("removing a member does not stop their active send", async () => {
    const chat = await chatApp();
    const project = await createTeam(chat, "ops");
    await addMember(chat, project.id, chat.memberId);
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const started = await startChat(chat, "team chat", chat.member, project.id);
    chat.app.socket.message(
      conn,
      JSON.stringify({ type: "watch", sessionId: started.sessionId }),
    );
    conn.frames = [];
    const removed = await chat.admin.call(
      "DELETE",
      `/api/projects/${project.id}/members/${chat.memberId}`,
    );
    expect(removed.status).toBe(200);
    expect(conn.frames).toEqual([{ type: "revoked", projectId: project.id }]);
    expect(conn.data.watching).toBeNull();
    conn.frames = [];
    started.script.content("hidden");
    await finish(chat, started.script);
    expect(chat.app.sessions.byId(started.sessionId)?.status).toBe("done");
    expect(conn.frames).toEqual([]);
    const refused = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(refused.status).toBe(404);
    close(chat, conn);
  });
  test("deleting one chat removes its usage row", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    await finish(chat, started.script);
    expect(chat.app.usage.forSession(started.sessionId)).toHaveLength(1);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(deleted.status).toBe(200);
    expect(chat.app.usage.forSession(started.sessionId)).toEqual([]);
    chat.app.socket.dispose();
  });
  test("team chats are changed by their owner or an admin, not another writer", async () => {
    const chat = await chatApp();
    const writer = await makeUser(chat, "maria");
    const project = await createTeam(chat, "ops");
    await addMember(chat, project.id, chat.memberId);
    await addMember(chat, project.id, writer.user.id);
    const changed = await startChat(chat, "first", chat.member, project.id);
    await finish(chat, changed.script);
    expect(
      (
        await chat.member.call("PATCH", `/api/sessions/${changed.sessionId}`, {
          body: { title: "Owned" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await chat.admin.call("PATCH", `/api/sessions/${changed.sessionId}`, {
          body: { title: "Admin" },
        })
      ).status,
    ).toBe(200);
    const pending = chat.scripted.next();
    const sent = await writer.client.call(
      "POST",
      `/api/sessions/${changed.sessionId}/messages`,
      { body: { message: "I wrote here" } },
    );
    expect(sent.status).toBe(201);
    await finish(chat, await pending);
    expect(
      (
        await writer.client.call(
          "PATCH",
          `/api/sessions/${changed.sessionId}`,
          { body: { title: "No" } },
        )
      ).status,
    ).toBe(403);
    expect(
      (await writer.client.call("DELETE", `/api/sessions/${changed.sessionId}`))
        .status,
    ).toBe(403);
    expect(
      (await chat.admin.call("DELETE", `/api/sessions/${changed.sessionId}`))
        .status,
    ).toBe(200);
    const owned = await startChat(chat, "second", chat.member, project.id);
    await finish(chat, owned.script);
    expect(
      (await chat.member.call("DELETE", `/api/sessions/${owned.sessionId}`))
        .status,
    ).toBe(200);
    chat.app.socket.dispose();
  });
});

describe("the personal project's settings", () => {
  test("its owner describes it and cannot name it", async () => {
    const chat = await chatApp();
    const described = await chat.member.call("PATCH", "/api/profile/project", {
      body: { description: "My scratch work" },
    });
    expect(described.status).toBe(200);
    expect((await described.json()).project).toMatchObject({
      id: chat.projectId,
      kind: "personal",
      name: "personal",
      description: "My scratch work",
    });
    // the admin's personal project is untouched
    expect(chat.app.projects.personal(chat.adminId)!.description).toBe("");
    const cleared = await chat.member.call("PATCH", "/api/profile/project", {
      body: { description: "" },
    });
    expect(cleared.status).toBe(200);
    for (const body of [
      { name: "notes" },
      { name: "notes", description: "x" },
      {},
      { description: "two\nlines" },
    ]) {
      expect(
        (await chat.member.call("PATCH", "/api/profile/project", { body }))
          .status,
      ).toBe(400);
    }
    chat.app.socket.dispose();
  });

  test("a username rename leaves the project named personal", async () => {
    const chat = await chatApp();
    const member = chat.app.users.byId(chat.memberId)!;
    const renamed = await chat.admin.call(
      "PATCH",
      `/api/users/${chat.memberId}`,
      { body: { username: `${member.username}_2` } },
    );
    expect(renamed.status).toBe(200);
    expect(chat.app.projects.personal(chat.memberId)!.name).toBe("personal");
    chat.app.socket.dispose();
  });

  test("the store refuses a personal project named otherwise and a team named personal", async () => {
    const chat = await chatApp();
    const insert = (id: string, kind: string, name: string) =>
      chat.app.db
        .query(
          "insert into projects (id, kind, name, owner_id, created_at) values (?, ?, ?, ?, 0)",
        )
        .run(id, kind, name, chat.adminId);
    expect(() => insert("t1", "team", "personal")).toThrow("CHECK");
    chat.app.db
      .query("delete from projects where owner_id = ? and kind = 'personal'")
      .run(chat.memberId);
    expect(() =>
      chat.app.db
        .query(
          "insert into projects (id, kind, name, owner_id, created_at) values ('p1', 'personal', 'notes', ?, 0)",
        )
        .run(chat.memberId),
    ).toThrow("CHECK");
    insert("t2", "team", "ops");
    expect(() => insert("t3", "team", "ops")).toThrow("UNIQUE");
    chat.app.socket.dispose();
  });

  test("the agent is told the project, and its description only when set", async () => {
    const chat = await chatApp();
    const first = await startChat(chat, "hi");
    const prompt = (script: Script) =>
      (script.body.messages as { content: string }[])[0]!.content;
    const username = chat.app.users.byId(chat.memberId)!.username;
    expect(prompt(first.script)).toContain(
      `You work in @${username}'s personal project.\n`,
    );
    await finish(chat, first.script);
    await chat.member.call("PATCH", "/api/profile/project", {
      body: { description: "My scratch work" },
    });
    const second = await startChat(chat, "again");
    expect(prompt(second.script)).toContain(": My scratch work\n");
    await finish(chat, second.script);
    chat.app.socket.dispose();
  });
});
