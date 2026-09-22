// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composed socket's audiences, watches, revocation and connection
// lifecycle, driven through the upgrade route with fake connections.

import { describe, expect, test } from "bun:test";
import { transact } from "../../src/server/db/index.ts";
import {
  CLOSE_BAD_COMMAND,
  CLOSE_DROPPED,
  CLOSE_REVOKED,
  type Conn,
  type ConnData,
} from "../../src/server/web/socket.ts";
import { PROTOCOL, type SocketEvent } from "../../src/shared/socket.ts";
import {
  collectLogs,
  ORIGIN,
  type TestClient,
  VERSION,
} from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

type Closed = { code?: number; reason?: string };
type FakeConn = Conn & {
  frames: SocketEvent[];
  closed: Closed[];
  sendResult: number | null;
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
    sendResult: null,
    send(text) {
      conn.frames.push(JSON.parse(text));
      return conn.sendResult ?? text.length;
    },
    close(code, reason) {
      conn.closed.push({ code, reason });
    },
  };
  return conn;
}

function frames<T extends SocketEvent["type"]>(
  conn: FakeConn,
  type: T,
): Extract<SocketEvent, { type: T }>[] {
  return conn.frames.filter(
    (frame): frame is Extract<SocketEvent, { type: T }> => frame.type === type,
  );
}

function close(chat: ChatApp, ...connections: FakeConn[]) {
  for (const conn of connections) chat.app.socket.close(conn);
  chat.app.socket.dispose();
}

async function finish(script: Script) {
  script.finish();
  script.usage();
  script.end();
  await tick();
  await tick();
}

function addTeam(chat: ChatApp, id: string) {
  chat.app.db
    .query(
      "insert into projects (id, kind, name, owner_id, created_at) values (?, 'team', ?, ?, ?)",
    )
    .run(id, id, chat.memberId, chat.app.now.value);
  chat.app.db
    .query(
      "insert into memberships (project_id, user_id, created_at) values (?, ?, ?)",
    )
    .run(id, chat.memberId, chat.app.now.value);
}

describe("the socket", () => {
  test("open sends hello with the current protocol and the build", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    expect(conn.frames).toEqual([
      { type: "hello", protocol: PROTOCOL, version: VERSION },
    ]);
    chat.app.socket.close(conn, 1001);
    chat.app.socket.dispose();
    expect(logs.events.filter((event) => event.area === "socket")).toEqual([
      {
        level: "info",
        area: "socket",
        msg: "socket open",
        fields: { user: "casey" },
      },
      {
        level: "info",
        area: "socket",
        msg: "socket close",
        fields: { user: "casey", code: 1001, cause: undefined },
      },
    ]);
  });

  test("a session envelope reaches its project's connections only", async () => {
    const chat = await chatApp();
    const member = await connection(chat, chat.member);
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(member);
    chat.app.socket.open(admin);
    const { script, sessionId } = await startChat(chat);
    expect(frames(member, "session").map((f) => f.session.id)).toEqual([
      sessionId,
    ]);
    expect(frames(admin, "session")).toEqual([]);
    script.reply("done");
    await tick();
    await tick();
    expect(frames(member, "session")).toHaveLength(2);
    expect(frames(admin, "session")).toEqual([]);
    close(chat, member, admin);
  });

  test("a memory frame reaches only connections holding its project", async () => {
    const chat = await chatApp();
    const member = await connection(chat, chat.member);
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(member);
    chat.app.socket.open(admin);
    member.frames = [];
    admin.frames = [];

    const saved = await chat.member.call(
      "PUT",
      `/api/projects/${chat.projectId}/memory`,
      { body: { entries: [{ topic: "Note", text: "remember" }], revision: 0 } },
    );

    expect(saved.status).toBe(200);
    expect(frames(member, "memory")).toEqual([
      {
        type: "memory",
        projectId: chat.projectId,
        automationId: null,
        revision: 1,
      },
    ]);
    expect(frames(admin, "memory")).toEqual([]);
    close(chat, member, admin);
  });

  test.serial(
    "knowledge frames reach the project, with nothing after login revocation",
    async () => {
      const chat = await chatApp();
      try {
        const member = await connection(chat, chat.member);
        const admin = await connection(chat, chat.admin);
        chat.app.socket.open(member);
        chat.app.socket.open(admin);
        member.frames = [];
        admin.frames = [];
        const path = `/api/projects/${chat.projectId}/knowledge`;
        const created = await chat.member.call("POST", path, {
          body: { name: "docs/x.md", text: "hello\n" },
        });
        expect(created.status).toBe(201);
        const { file } = await created.json();
        expect(frames(member, "knowledge")).toEqual([
          {
            type: "knowledge",
            projectId: chat.projectId,
            file,
            deleted: false,
          },
        ]);
        expect(frames(admin, "knowledge")).toEqual([]);
        chat.app.now.value += 1000;
        const deleted = await chat.member.call(
          "DELETE",
          `${path}/files/${file.id}`,
        );
        expect(deleted.status).toBe(204);
        expect(frames(member, "knowledge").at(-1)).toEqual({
          type: "knowledge",
          projectId: chat.projectId,
          file: { ...file, revision: 2, updatedAt: chat.app.now.value },
          deleted: true,
        });
        expect(
          chat.app.knowledge.versions(chat.projectId, file.id)[0],
        ).toMatchObject({ revision: 2, deleted: true });
        expect(frames(admin, "knowledge")).toEqual([]);

        const activeClient = chat.app.client();
        await activeClient.login("casey", "pw");
        const active = await connection(chat, activeClient);
        chat.app.socket.open(active);
        const logout = await chat.member.call("POST", "/api/logout");
        expect(logout.status).toBe(200);
        expect(member.closed).toEqual([
          { code: CLOSE_REVOKED, reason: "signed out" },
        ]);
        expect(active.closed).toEqual([]);
        const before = [...member.frames];
        const saved = await activeClient.call("POST", path, {
          body: { name: "new.md", text: "after revocation" },
        });
        expect(saved.status).toBe(201);
        expect(member.frames).toEqual(before);
        expect(frames(active, "knowledge")).toHaveLength(1);
        expect(frames(admin, "knowledge")).toEqual([]);
        close(chat, member, admin, active);
      } finally {
        await chat.app.shutdown();
        chat.app.db.close();
      }
    },
  );

  test("watch gets live state and streams only to the watcher", async () => {
    const chat = await chatApp();
    const watching = await connection(chat, chat.member);
    const idle = await connection(chat, chat.member);
    chat.app.socket.open(watching);
    chat.app.socket.open(idle);
    const { detail, script, sessionId } = await startChat(chat);
    chat.app.socket.message(
      watching,
      JSON.stringify({ type: "watch", sessionId }),
    );
    expect(frames(watching, "watched")).toEqual([
      {
        type: "watched",
        sessionId,
        live: expect.objectContaining({
          sendId: detail.send.id,
          messageId: detail.messages[1].id,
        }),
      },
    ]);

    script.content("x");
    script.reasoning("y");
    await tick();
    expect(frames(watching, "delta")).toEqual([
      {
        type: "delta",
        sessionId,
        sendId: detail.send.id,
        messageId: detail.messages[1].id,
        seq: 1,
        content: "x",
        contentAt: 0,
        reasoningAt: 0,
      },
      {
        type: "delta",
        sessionId,
        sendId: detail.send.id,
        messageId: detail.messages[1].id,
        seq: 2,
        reasoning: "y",
        contentAt: 1,
        reasoningAt: 0,
      },
    ]);
    expect(frames(idle, "delta")).toEqual([]);

    await finish(script);
    expect(frames(watching, "session")).toHaveLength(2);
    expect(frames(idle, "session")).toHaveLength(2);
    close(chat, watching, idle);
  });

  test.serial(
    "a locked connection cannot watch a session or hear project changes",
    async () => {
      const chat = await chatApp();
      const { script, sessionId } = await startChat(chat);
      chat.app.users.setMustChangePassword(chat.memberId, true);
      const conn = await connection(chat, chat.member);
      chat.app.socket.open(conn);

      chat.app.socket.message(
        conn,
        JSON.stringify({ type: "watch", sessionId }),
      );

      expect(conn.data.watching).toBeNull();
      expect(frames(conn, "watched")).toEqual([]);
      transact(chat.app.db, () => ({
        result: undefined,
        events: [
          {
            type: "memory.changed" as const,
            data: {
              projectId: chat.projectId,
              automationId: null,
              revision: 1,
            },
          },
        ],
      }));
      expect(frames(conn, "memory")).toEqual([]);
      chat.app.knowledge.create(
        chat.projectId,
        {
          kind: "user",
          id: chat.memberId,
          name: "casey",
          sessionId: null,
          origin: null,
        },
        "locked.md",
        "not sent to the locked tab",
      );
      expect(frames(conn, "knowledge")).toEqual([]);
      await finish(script);
      expect(frames(conn, "session")).toEqual([]);
      close(chat, conn);
    },
  );

  test("content is rendered after the HTML clock interval", async () => {
    const chat = await chatApp();
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const { detail, script, sessionId } = await startChat(chat);
    chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    script.content("x");
    await tick();
    expect(frames(conn, "html")).toEqual([]);
    chat.app.now.value += 1_000;
    script.content("yz");
    await tick();
    expect(frames(conn, "html")).toEqual([
      expect.objectContaining({
        type: "html",
        sessionId,
        sendId: detail.send.id,
        messageId: detail.messages[1].id,
        htmlAt: 3,
      }),
    ]);
    await finish(script);
    close(chat, conn);
  });

  test("unwatch stops frames and a new watch replaces the old one", async () => {
    const chat = await chatApp();
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const first = await startChat(chat, "first");
    const second = await startChat(chat, "second");

    chat.app.socket.message(
      conn,
      JSON.stringify({ type: "watch", sessionId: first.sessionId }),
    );
    first.script.content("before");
    await tick();
    chat.app.socket.message(
      conn,
      JSON.stringify({ type: "unwatch", sessionId: first.sessionId }),
    );
    first.script.content("after");
    await tick();
    expect(frames(conn, "delta").map((f) => f.content)).toEqual(["before"]);

    chat.app.socket.message(
      conn,
      JSON.stringify({ type: "watch", sessionId: first.sessionId }),
    );
    chat.app.socket.message(
      conn,
      JSON.stringify({ type: "watch", sessionId: second.sessionId }),
    );
    first.script.content("replaced");
    second.script.content("current");
    await tick();
    expect(frames(conn, "delta").map((f) => f.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    await finish(first.script);
    await finish(second.script);
    close(chat, conn);
  });

  test("an admin cannot watch a member's personal chat", async () => {
    const chat = await chatApp();
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(admin);
    const { script, sessionId } = await startChat(chat);
    chat.app.socket.message(
      admin,
      JSON.stringify({ type: "watch", sessionId }),
    );
    script.content("private");
    await tick();
    expect(frames(admin, "watched")).toEqual([]);
    expect(frames(admin, "delta")).toEqual([]);
    await finish(script);
    close(chat, admin);
  });

  test("a bad command closes the connection with 4002", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    chat.app.socket.message(conn, JSON.stringify({ type: "watch" }));
    expect(conn.closed).toEqual([
      { code: CLOSE_BAD_COMMAND, reason: "bad command" },
    ]);
    chat.app.socket.close(conn, CLOSE_BAD_COMMAND);
    chat.app.socket.dispose();
    expect(
      logs.events.findLast((event) => event.msg === "socket close"),
    ).toEqual({
      level: "info",
      area: "socket",
      msg: "socket close",
      fields: {
        user: "casey",
        code: CLOSE_BAD_COMMAND,
        cause: "protocol",
      },
    });
  });

  test("a revocation before open closes without registering", async () => {
    const chat = await chatApp();
    const conn = await connection(chat, chat.member);
    transact(chat.app.db, () => ({
      result: 0,
      events: [
        {
          type: "login.revoked" as const,
          data: {
            userId: conn.data.principal.userId,
            loginId: conn.data.principal.loginId,
          },
        },
      ],
    }));
    chat.app.socket.open(conn);
    expect(conn.closed).toEqual([
      { code: CLOSE_REVOKED, reason: "signed out" },
    ]);
    expect(conn.frames).toEqual([]);
    expect(chat.app.socket.size()).toBe(0);
    close(chat, conn);
  });

  test("a user-wide login revocation closes only that user's socket", async () => {
    const chat = await chatApp();
    const member = await connection(chat, chat.member);
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(member);
    chat.app.socket.open(admin);
    transact(chat.app.db, () => ({
      result: 0,
      events: [
        {
          type: "login.revoked" as const,
          data: { userId: chat.memberId, loginId: null },
        },
      ],
    }));
    expect(member.closed).toEqual([{ code: 4001, reason: "signed out" }]);
    expect(admin.closed).toEqual([]);
    close(chat, member, admin);
  });

  test("access revocation removes delivery and the active watch", async () => {
    const chat = await chatApp();
    addTeam(chat, "socket-team");
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const { script, sessionId } = await startChat(
      chat,
      "team chat",
      chat.member,
      "socket-team",
    );
    chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    conn.frames = [];
    chat.app.db
      .query("delete from memberships where project_id = ? and user_id = ?")
      .run("socket-team", chat.memberId);
    transact(chat.app.db, () => ({
      result: 0,
      events: [
        {
          type: "access.changed" as const,
          data: { userIds: [chat.memberId] },
        },
      ],
    }));
    expect(conn.frames).toEqual([
      { type: "revoked", projectId: "socket-team" },
    ]);
    expect(conn.data.projects.has("socket-team")).toBe(false);
    expect(conn.data.watching).toBeNull();
    transact(chat.app.db, () => ({
      result: undefined,
      events: [
        {
          type: "memory.changed" as const,
          data: {
            projectId: "socket-team",
            automationId: null,
            revision: 1,
          },
        },
      ],
    }));
    expect(frames(conn, "memory")).toEqual([]);
    script.content("hidden");
    await finish(script);
    expect(frames(conn, "delta")).toEqual([]);
    expect(frames(conn, "session")).toEqual([]);
    close(chat, conn);
  });

  test("a dropped send closes only that connection with 1013", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const conn = await connection(chat, chat.member);
    conn.sendResult = 0;
    chat.app.socket.open(conn);
    expect(conn.closed).toEqual([
      { code: CLOSE_DROPPED, reason: "dropped a frame" },
    ]);
    chat.app.socket.close(conn, CLOSE_DROPPED);
    const slow = await connection(chat, chat.member);
    slow.sendResult = -1;
    chat.app.socket.open(slow);
    chat.app.socket.close(slow, 1006);
    chat.app.socket.dispose();
    expect(
      logs.events
        .filter((event) => event.msg === "socket close")
        .map((event) => event.fields),
    ).toEqual([
      { user: "casey", code: CLOSE_DROPPED, cause: "dropped" },
      { user: "casey", code: 1006, cause: "backpressure" },
    ]);
  });

  test("session deletion reaches the project and clears its watch", async () => {
    const chat = await chatApp();
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const { script, sessionId } = await startChat(chat);
    chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    await finish(script);
    const res = await chat.member.call("DELETE", `/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(frames(conn, "deleted")).toEqual([
      { type: "deleted", projectId: chat.projectId, sessionId },
    ]);
    expect(conn.data.watching).toBeNull();
    close(chat, conn);
  });

  test("closeAll closes every connection with the given code", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const member = await connection(chat, chat.member);
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(member);
    chat.app.socket.open(admin);
    chat.app.socket.closeAll(1012, "restart");
    expect(member.closed).toEqual([{ code: 1012, reason: "restart" }]);
    expect(admin.closed).toEqual([{ code: 1012, reason: "restart" }]);
    chat.app.socket.close(member, 1012);
    chat.app.socket.close(admin, 1012);
    chat.app.socket.dispose();
    expect(
      logs.events
        .filter((event) => event.msg === "socket close")
        .map((event) => event.fields),
    ).toEqual([
      { user: "casey", code: 1012, cause: "shutdown" },
      { user: "admin", code: 1012, cause: "shutdown" },
    ]);
  });

  test("a work round's reply streams to the watcher and its slot moves to work", async () => {
    const chat = await chatApp();
    const conn = await connection(chat, chat.member);
    chat.app.socket.open(conn);
    const { detail, script, sessionId } = await startChat(chat, "when");
    chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    // narration streams as a delta, then the first call delta moves the
    // reply into the fold: a durable session envelope with slot work
    script.content("checking");
    await tick();
    script.toolCall({
      id: "c1",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    expect(frames(conn, "delta").length).toBeGreaterThanOrEqual(1);
    const work = frames(conn, "session").find((f) =>
      f.messages.some(
        (m) => m.id === detail.messages[1].id && m.slot === "work",
      ),
    );
    expect(work).toBeDefined();
    // the work reply moved inside the fold; the tool row travels durably,
    // never as a stream frame
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    await tick();
    close(chat, conn);
  });

  test("size counts opens and close forgets a connection", async () => {
    const chat = await chatApp();
    const first = await connection(chat, chat.member);
    const second = await connection(chat, chat.member);
    chat.app.socket.open(first);
    chat.app.socket.open(second);
    expect(chat.app.socket.size()).toBe(2);
    chat.app.socket.close(first);
    expect(chat.app.socket.size()).toBe(1);
    close(chat, second);
  });
});

describe("automation socket events", () => {
  test("changes and deletions reach connections holding the project", async () => {
    const chat = await chatApp();
    const member = await connection(chat, chat.member);
    const admin = await connection(chat, chat.admin);
    chat.app.socket.open(member);
    chat.app.socket.open(admin);
    const automation = await createAutomation(chat);
    expect(frames(member, "automation")).toEqual([
      {
        type: "automation",
        projectId: chat.projectId,
        automation,
      },
    ]);
    expect(frames(admin, "automation")).toEqual([]);

    await chat.member.call("DELETE", `/api/automations/${automation.id}`);
    expect(frames(member, "automationDeleted")).toEqual([
      {
        type: "automationDeleted",
        projectId: chat.projectId,
        automationId: automation.id,
      },
    ]);
    expect(frames(admin, "automationDeleted")).toEqual([]);
    close(chat, member, admin);
    await chat.app.shutdown();
  });
});
