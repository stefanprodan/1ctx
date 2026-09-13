// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Session routes over the composed app: visibility, ordering, filters,
// details, deletion, repair and the guards around a running send.

import { describe, expect, test } from "bun:test";
import { compose } from "../../src/server/compose.ts";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import { RESTART_ERROR, titleFrom } from "../../src/server/sessions/index.ts";
import { fakeFetch, VERSION } from "../helpers/app.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
} from "../helpers/chat.ts";

async function finish(script: Script, content = "done") {
  script.reply(content);
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

describe("GET /api/sessions", () => {
  test("lists visible chats running first and then by activity", async () => {
    const chat = await chatApp();
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const old = await startChat(chat, "old member chat");
    await finish(old.script);
    chat.app.now.value += 100;
    const recent = await startChat(chat, "recent member chat");
    await finish(recent.script);
    chat.app.now.value += 100;
    const running = await startChat(chat, "running member chat");
    const admin = await startChat(chat, "admin chat", chat.admin, adminProject);

    const memberBody = await (
      await chat.member.call("GET", "/api/sessions")
    ).json();
    expect(memberBody.sessions.map((s: { id: string }) => s.id)).toEqual([
      running.sessionId,
      recent.sessionId,
      old.sessionId,
    ]);
    const adminBody = await (
      await chat.admin.call("GET", "/api/sessions")
    ).json();
    expect(adminBody.sessions.map((s: { id: string }) => s.id)).toEqual([
      admin.sessionId,
    ]);

    await finish(running.script);
    await finish(admin.script);
    chat.app.socket.dispose();
  });

  test("filters titles case-insensitively and narrows to a project", async () => {
    const chat = await chatApp();
    addTeam(chat, "sessions-team");
    const personal = await startChat(chat, "Alpha Release");
    await finish(personal.script);
    const team = await startChat(
      chat,
      "Team Notes",
      chat.member,
      "sessions-team",
    );
    await finish(team.script);

    const searched = await (
      await chat.member.call("GET", "/api/sessions?q=pHa")
    ).json();
    expect(searched.sessions.map((s: { id: string }) => s.id)).toEqual([
      personal.sessionId,
    ]);
    const narrowed = await (
      await chat.member.call("GET", "/api/sessions?project=sessions-team")
    ).json();
    expect(narrowed.sessions.map((s: { id: string }) => s.id)).toEqual([
      team.sessionId,
    ]);
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    expect(
      (await chat.member.call("GET", `/api/sessions?project=${adminProject}`))
        .status,
    ).toBe(404);
    chat.app.socket.dispose();
  });
});

describe("GET /api/sessions/:id", () => {
  test("answers messages, send and live without exposing personal chats", async () => {
    const chat = await chatApp();
    const mine = await startChat(chat, "member detail");
    const detailRes = await chat.member.call(
      "GET",
      `/api/sessions/${mine.sessionId}`,
    );
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.messages).toHaveLength(2);
    expect(detail.send.id).toBe(mine.detail.send.id);
    expect(detail.live).toMatchObject({
      sendId: mine.detail.send.id,
      messageId: mine.detail.messages[1].id,
    });
    expect(
      (await chat.admin.call("GET", `/api/sessions/${mine.sessionId}`)).status,
    ).toBe(404);

    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    const theirs = await startChat(
      chat,
      "admin detail",
      chat.admin,
      adminProject,
    );
    expect(
      (await chat.member.call("GET", `/api/sessions/${theirs.sessionId}`))
        .status,
    ).toBe(404);
    await finish(mine.script);
    await finish(theirs.script);
    chat.app.socket.dispose();
  });
});

describe("DELETE /api/sessions/:id", () => {
  test("refuses a running chat and deletes its rows after it finishes", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    const running = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(running.status).toBe(409);
    await finish(started.script);
    const deleted = await chat.member.call(
      "DELETE",
      `/api/sessions/${started.sessionId}`,
    );
    expect(deleted.status).toBe(200);
    expect(chat.app.sessions.byId(started.sessionId)).toBeNull();
    expect(chat.app.sessions.messages(started.sessionId)).toEqual([]);
    expect(chat.app.sessions.lastSend(started.sessionId)).toBeNull();
    chat.app.socket.dispose();
  });

  test.skip("a visible non-owner cannot delete a chat", () => {
    // Team projects have no route yet, so v0 cannot make another owner
    // visible through supported application behavior.
  });
});

describe("GET /api/projects/:id/agents", () => {
  test("lists every agent only for a visible project", async () => {
    const chat = await chatApp();
    const visible = await chat.member.call(
      "GET",
      `/api/projects/${chat.projectId}/agents`,
    );
    expect(visible.status).toBe(200);
    expect(await visible.json()).toEqual({
      agents: [expect.objectContaining({ id: chat.agentId, name: "coder" })],
    });
    const adminProject = chat.app.projects.personal(chat.adminId)!.id;
    expect(
      (await chat.member.call("GET", `/api/projects/${adminProject}/agents`))
        .status,
    ).toBe(404);
    chat.app.socket.dispose();
  });
});

describe("session titles", () => {
  test("uses the trimmed first line cut to 80 characters", async () => {
    const chat = await chatApp();
    const line = "a".repeat(100);
    const started = await startChat(chat, `  ${line}  \nsecond line`);
    expect(started.detail.session.title).toBe(`${"a".repeat(79)}…`);
    expect(started.detail.session.title).toBe(titleFrom(`  ${line}  \nnext`));
    await finish(started.script);
    chat.app.socket.dispose();
  });
});

describe("agent deletion", () => {
  test("refuses an agent with a chat and allows it after chat deletion", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    await finish(started.script);
    const used = await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`);
    expect(used.status).toBe(409);
    expect(await used.json()).toEqual({ error: "a chat runs on coder" });
    expect(
      (await chat.member.call("DELETE", `/api/sessions/${started.sessionId}`))
        .status,
    ).toBe(200);
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    chat.app.socket.dispose();
  });
});

describe("boot repair", () => {
  test("fails rows left running and publishes their repaired revision", async () => {
    const chat = await chatApp();
    const store = chat.app.sessions;
    const session = store.create({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      title: "interrupted",
      now: chat.app.now.value,
    });
    const user = store.addUserMessage({
      sessionId: session.id,
      userId: chat.memberId,
      content: "hello",
      now: chat.app.now.value,
    });
    const reply = store.addReply({
      sessionId: session.id,
      agentId: chat.agentId,
      model: "model",
      now: chat.app.now.value,
    });
    const send = store.createSend({
      sessionId: session.id,
      userId: chat.memberId,
      agentId: chat.agentId,
      providerId: chat.providerId,
      model: "model",
      firstMessageId: user.id,
      now: chat.app.now.value,
    });
    const before = store.touch(session.id, {
      status: "running",
      now: chat.app.now.value,
    })!;
    const seen: Extract<BusEvent, { type: "session.changed" }>["data"][] = [];
    const stop = subscribe((event) => {
      if (event.type === "session.changed") seen.push(event.data);
    });
    chat.app.socket.dispose();
    const fake = fakeFetch();
    const repaired = await compose({
      db: chat.app.db,
      secret: (name) => (name === "admin" ? "hunter2-test" : null),
      clock: () => chat.app.now.value,
      fetcher: fake.fetcher,
      log: () => silent,
      version: VERSION,
      secureCookie: false,
      trustProxy: false,
    });
    stop();

    expect(repaired.sessions.byId(session.id)).toMatchObject({
      status: "failed",
      revision: before.revision + 1,
    });
    expect(repaired.sessions.message(reply.id)).toMatchObject({
      status: "failed",
      error: RESTART_ERROR,
    });
    expect(repaired.sessions.send(send.id)).toMatchObject({
      status: "failed",
      cause: "restart",
      error: RESTART_ERROR,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      projectId: chat.projectId,
      session: { id: session.id, revision: before.revision + 1 },
      messages: [],
      send: { id: send.id, cause: "restart" },
    });
    repaired.socket.dispose();
  });
});

describe("message limits and admission", () => {
  test("refuses a 300 KB message on create and send", async () => {
    const chat = await chatApp();
    const oversized = "x".repeat(300 * 1024);
    const create = await chat.member.call("POST", "/api/sessions", {
      body: {
        projectId: chat.projectId,
        agentId: chat.agentId,
        message: oversized,
      },
    });
    // The JSON exceeds the route cap before the parser, so the body
    // reader refuses it with 413 rather than the parser's 400.
    expect(create.status).toBe(413);

    const started = await startChat(chat);
    await finish(started.script);
    const send = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: oversized } },
    );
    expect(send.status).toBe(413);
    chat.app.socket.dispose();
  });

  test("refuses a second message while the first is running", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    const second = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Oana Pellea is sending" });
    await finish(started.script);
    chat.app.socket.dispose();
  });
});

describe("the usage on the summary", () => {
  test("the detail and the list carry the last counted round, by order, not by time", async () => {
    const chat = await chatApp();
    const first = await startChat(chat, "one");
    first.script.content("a");
    first.script.finish();
    first.script.usage({ prompt: 10, completion: 5 });
    first.script.end();
    await tick();
    await tick();
    // the fake clock does not move, so the second round has the same
    // timestamp and the same round number as the first
    const pending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      {
        body: { message: "two" },
      },
    );
    const second = await pending;
    second.content("b");
    second.finish();
    second.usage({ prompt: 40, completion: 9 });
    second.end();
    await tick();
    await tick();
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${first.sessionId}`)
    ).json();
    expect(detail.session.usage).toMatchObject({
      promptTokens: 40,
      completionTokens: 9,
      contextLength: 1048576,
    });
    const list = await (await chat.member.call("GET", "/api/sessions")).json();
    expect(list.sessions[0].usage).toMatchObject({ promptTokens: 40 });
    chat.app.socket.dispose();
  });

  test("a stopped send after a counted one keeps the counted round", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "one");
    await finish(started.script);
    const pending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/messages`,
      { body: { message: "two" } },
    );
    const second = await pending;
    second.content("partial");
    await chat.member.call("POST", `/api/sessions/${started.sessionId}/stop`);
    await tick();
    await tick();
    const detail = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(detail.session.status).toBe("stopped");
    expect(detail.session.usage).toMatchObject({ promptTokens: 10 });
    chat.app.socket.dispose();
  });
});
