// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Regeneration through the composed app: admission, visibility and the
// replacement send's durable rows.

import { describe, expect, test } from "bun:test";
import type { ChatApp, Script } from "../../helpers/chat.ts";
import { chatApp, startChat, tick, waitScript } from "../../helpers/chat.ts";

const timeCall = {
  id: "time-1",
  name: "get_current_time",
  arguments: '{"timezone":"UTC"}',
};

async function settle(chat: ChatApp, sessionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    await tick();
  }
  throw new Error(`chat ${sessionId} did not settle`);
}

async function finish(
  chat: ChatApp,
  sessionId: string,
  script: Script,
  text = "done",
): Promise<void> {
  script.reply(text);
  await settle(chat, sessionId);
}

describe("POST /api/sessions/:id/regenerate", () => {
  test("keeps the user row and replaces a finished tool send", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "what time is it");
    started.script.reasoning("checking");
    started.script.toolRound([timeCall]);
    started.script.end();
    const second = await waitScript(chat.scripted, 2);
    await finish(chat, started.sessionId, second, "the old answer");

    const before = chat.app.sessions.messages(started.sessionId);
    const user = before.find((message) => message.kind === "user")!;
    const removed = before
      .filter((message) => message.kind !== "user")
      .map((message) => message.id);
    const oldSendId = user.sendId;
    expect(before.some((message) => message.kind === "tool")).toBeTrue();
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from usage where send_id = ?",
        )
        .get(oldSendId)!.n,
    ).toBeGreaterThan(0);

    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/regenerate`,
    );
    expect(response.status).toBe(201);
    const detail = await response.json();
    const replacement = await pending;

    expect(detail.session.status).toBe("running");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({
      id: user.id,
      seq: user.seq,
      kind: "user",
      content: user.content,
      sendId: detail.send.id,
    });
    expect(detail.messages[1]).toMatchObject({
      kind: "reply",
      status: "streaming",
      sendId: detail.send.id,
    });
    expect(detail.messages[1].seq).toBeGreaterThan(user.seq);
    expect(detail.send.id).not.toBe(oldSendId);
    expect(chat.app.sessions.send(oldSendId)).toBeNull();
    expect(
      chat.app.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from usage where send_id = ?",
        )
        .get(oldSendId)!.n,
    ).toBe(0);
    expect(
      detail.messages
        .map((message: { id: string }) => message.id)
        .filter((id: string) => removed.includes(id)),
    ).toEqual([]);

    await finish(chat, started.sessionId, replacement, "the new answer");
    const fresh = await (
      await chat.member.call("GET", `/api/sessions/${started.sessionId}`)
    ).json();
    expect(fresh.session.status).toBe("done");
    expect(fresh.messages[0].id).toBe(user.id);
    expect(fresh.messages.at(-1).content).toBe("the new answer");
    expect(
      fresh.messages
        .map((message: { id: string }) => message.id)
        .filter((id: string) => removed.includes(id)),
    ).toEqual([]);
    chat.app.socket.dispose();
  });

  test("refuses regeneration while the send holds the lock", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/regenerate`,
    );
    expect(response.status).toBe(409);
    expect(chat.app.sessions.messages(started.sessionId)).toHaveLength(2);
    await finish(chat, started.sessionId, started.script);
    chat.app.socket.dispose();
  });

  test("refuses a last user row or a session without one", async () => {
    const chat = await chatApp();
    const lastUser = await startChat(chat, "last user");
    await finish(chat, lastUser.sessionId, lastUser.script);
    chat.app.db
      .query("delete from messages where session_id = ? and kind <> 'user'")
      .run(lastUser.sessionId);
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${lastUser.sessionId}/regenerate`,
        )
      ).status,
    ).toBe(400);

    const noUser = await startChat(chat, "no user");
    await finish(chat, noUser.sessionId, noUser.script);
    chat.app.db
      .query("delete from messages where session_id = ?")
      .run(noUser.sessionId);
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${noUser.sessionId}/regenerate`,
        )
      ).status,
    ).toBe(400);
    chat.app.socket.dispose();
  });

  test("hides a personal session from another user", async () => {
    const chat = await chatApp();
    const started = await startChat(chat);
    await finish(chat, started.sessionId, started.script);
    const response = await chat.admin.call(
      "POST",
      `/api/sessions/${started.sessionId}/regenerate`,
    );
    expect(response.status).toBe(404);
    chat.app.socket.dispose();
  });
});
