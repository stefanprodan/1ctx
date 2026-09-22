// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Drain: a stopped send holds the lock until its stream has let go, so
// a new send never writes over a reply still being written; and an old
// send's cleanup never frees a newer send's lock.

import { describe, expect, test } from "bun:test";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

describe("drain", () => {
  test("a stop claims at once and ends after the stream lets go", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    script.content("part");
    await tick();
    const stop = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/stop`,
    );
    expect(stop.status).toBe(200);
    expect(script.aborted).toBe(true);
    await tick();
    // the rows end after the provider iteration lets go
    const reply = chat.app.sessions.message(detail.messages[1].id)!;
    expect(reply.status).toBe("stopped");
    expect(reply.content).toBe("part");
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("stopped");
    // once it has let go the lock is free
    await tick();
    expect(chat.app.runner.registry.get(sessionId)).toBeNull();
    const next = chat.scripted.next();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(res.status).toBe(201);
    (await next).reply("ok");
    await tick();
  });

  test("frames after the stop are dropped, never written", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    script.content("before");
    await tick();
    const frames: unknown[] = [];
    const conn = {
      data: {
        principal: {
          userId: chat.memberId,
          username: "casey",
          fullName: "Casey Doe",
          role: "member" as const,
          mustChangePassword: false,
          loginId: "l",
        },
        projects: new Set([chat.projectId]),
        watching: null,
      },
      send: (text: string) => {
        frames.push(JSON.parse(text));
        return text.length;
      },
      close: () => {},
    };
    chat.app.socket.open(conn);
    chat.app.socket.message(conn, JSON.stringify({ type: "watch", sessionId }));
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    const before = frames.length;
    script.content("after");
    await tick();
    expect(
      frames
        .slice(before)
        .some((frame) => (frame as { type?: string }).type === "delta"),
    ).toBe(false);
    expect(chat.app.sessions.message(detail.messages[1].id)!.content).toBe(
      "before",
    );
    chat.app.socket.close(conn);
    await tick();
  });

  test("a stop on a chat that is not running is a no-op", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    script.reply("done");
    await tick();
    await tick();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/stop`,
    );
    expect(res.status).toBe(200);
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("done");
  });

  test("a stop during a work round holds the lock until the stream lets go", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "when");
    script.content("checking");
    script.toolCall({
      id: "c1",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    // the rows end once the claimed main round releases
    const reply = chat.app.sessions.message(detail.messages[1].id)!;
    expect(reply.status).toBe("stopped");
    expect(reply.slot).toBe("work");
    expect(chat.app.sessions.send(detail.send.id)!.cause).toBe("stop");
    expect(script.aborted).toBe(true);
    // once the stream lets go the lock is free and a new send goes
    await tick();
    await tick();
    expect(chat.app.runner.registry.get(sessionId)).toBeNull();
    const next = chat.scripted.next();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(res.status).toBe(201);
    (await next).reply("ok");
    await tick();
    chat.app.socket.dispose();
  });

  test("an old send's cleanup never frees its replacement", async () => {
    const chat = await chatApp();
    const first = await startChat(chat);
    await chat.member.call("POST", `/api/sessions/${first.sessionId}/stop`);
    await tick();
    await tick();
    const next = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      {
        body: { message: "again" },
      },
    );
    const second = await next;
    const held = chat.app.runner.registry.get(first.sessionId)!;
    // the first send's stream lets go late: the registry still holds
    // the second
    first.script.end();
    await tick();
    expect(chat.app.runner.registry.get(first.sessionId)).toBe(held);
    second.reply("ok");
    await tick();
    await tick();
    expect(chat.app.runner.registry.get(first.sessionId)).toBeNull();
  });
});
