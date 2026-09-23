// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admission: one send per session, a cap on sends in the process and a
// cap per user, decided before anything is written, with the refusal
// naming who holds the lock.

import { describe, expect, test } from "bun:test";
import { Registry } from "../../src/server/runner/index.ts";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

describe("admission", () => {
  test("a second send into a running chat is refused with who is sending", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Casey Doe is sending" });
    // nothing was written for the refused send
    expect(chat.app.sessions.messages(sessionId)).toHaveLength(2);
    script.reply("ok");
    await tick();
  });

  test("the process cap refuses with a 429 and frees as sends end", async () => {
    const chat = await chatApp({
      registry: new Registry({ running: 2, perUser: 10 }),
    });
    const a = await startChat(chat, "a");
    const b = await startChat(chat, "b");
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "c" },
    });
    expect(res.status).toBe(429);
    expect(chat.app.sessions.list([chat.projectId], "").rows).toHaveLength(2);
    a.script.reply("done");
    await tick();
    await tick();
    const c = await startChat(chat, "c");
    expect(c.detail.session.status).toBe("running");
    b.script.reply("done");
    c.script.reply("done");
    await tick();
  });

  test("the cap per user counts that user's sends alone", async () => {
    const chat = await chatApp({
      registry: new Registry({ running: 10, perUser: 1 }),
    });
    const mine = await startChat(chat, "mine");
    const refused = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "1 of your chats are running; wait for one",
    });
    // the admin's own project is not bound by the member's count
    const admins = chat.app.projects.personal(chat.adminId)!.id;
    const theirs = await startChat(chat, "theirs", chat.admin, admins);
    expect(theirs.detail.session.status).toBe("running");
    mine.script.reply("a");
    theirs.script.reply("b");
    await tick();
  });

  test("an agent that is not there, or a project the caller may not see, is refused before the lock", async () => {
    const chat = await chatApp();
    const noAgent = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: "none", message: "x" },
    });
    expect(noAgent.status).toBe(400);
    const admins = chat.app.projects.personal(chat.adminId)!.id;
    const notMine = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: admins, agentId: chat.agentId, message: "x" },
    });
    expect(notMine.status).toBe(404);
    expect(chat.app.runner.registry.size).toBe(0);
  });

  test("a second message during a work round is refused while the lock is held", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat, "when");
    // the reply moves into the fold at the first call delta; the send is
    // still running, so a second message is refused
    script.content("checking");
    script.toolCall({
      id: "c1",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Casey Doe is sending" });
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    await tick();
    expect(script.aborted).toBe(true);
    chat.app.socket.dispose();
  });

  test("after shutdown nothing is admitted", async () => {
    const chat = await chatApp();
    await chat.app.shutdown();
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    expect(res.status).toBe(409);
  });
});
