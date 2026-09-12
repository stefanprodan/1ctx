// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The three transactions of a send: startSend writes the session, the
// user message, the streaming reply, the send row and the running
// state together, or nothing; finalizeSend writes the reply's end, its
// usage and the send's end together; each bumps the revision once and
// publishes one envelope after commit, and a checkpoint in between
// bumps nothing.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

function envelopes() {
  const seen: Extract<BusEvent, { type: "session.changed" }>["data"][] = [];
  const stop = subscribe((e) => {
    if (e.type === "session.changed") seen.push(e.data);
  });
  return { seen, stop };
}

describe("startSend", () => {
  test("writes the session, the user message, the reply, the send and the state in one revision", async () => {
    const chat = await chatApp();
    const { seen, stop } = envelopes();
    try {
      const { detail, sessionId } = await startChat(chat, "Hello there\nmore");
      expect(detail.session).toMatchObject({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "Hello there",
        status: "running",
        revision: 1,
      });
      expect(detail.messages.map((m: { kind: string }) => m.kind)).toEqual([
        "user",
        "reply",
      ]);
      expect(detail.messages[0]).toMatchObject({
        userId: chat.memberId,
        content: "Hello there\nmore",
        status: "done",
        seq: 1,
      });
      expect(detail.messages[1]).toMatchObject({
        agentId: chat.agentId,
        status: "streaming",
        seq: 2,
      });
      expect(detail.send).toMatchObject({
        sessionId,
        status: "running",
        firstMessageId: detail.messages[0].id,
        userId: chat.memberId,
      });
      expect(detail.live).toMatchObject({
        sendId: detail.send.id,
        messageId: detail.messages[1].id,
        seq: 0,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].session.revision).toBe(1);
      expect(seen[0].messages).toHaveLength(2);
      expect(seen[0].send?.id).toBe(detail.send.id);
    } finally {
      stop();
    }
  });

  test("a write that fails leaves no row and no lock", async () => {
    const chat = await chatApp();
    const { seen, stop } = envelopes();
    try {
      const store = chat.app.sessions;
      const original = store.createSend.bind(store);
      store.createSend = () => {
        throw new Error("disk full");
      };
      try {
        // a store failure is a bug, and the router lets it propagate
        await expect(
          chat.member.call("POST", "/api/sessions", {
            body: {
              projectId: chat.projectId,
              agentId: chat.agentId,
              message: "x",
            },
          }),
        ).rejects.toThrow("disk full");
      } finally {
        store.createSend = original;
      }
      expect(seen).toEqual([]);
      expect(store.list([chat.projectId], "")).toEqual([]);
      expect(chat.app.runner.registry.size).toBe(0);
      // and the next send is admitted
      const again = await startChat(chat);
      expect(again.detail.session.status).toBe("running");
    } finally {
      stop();
    }
  });
});

describe("the checkpoint", () => {
  test("writes the partial reply without touching the revision", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    const replyId = detail.messages[1].id;
    script.content("a".repeat(3000));
    await tick();
    const row = chat.app.sessions.message(replyId)!;
    expect(row.status).toBe("streaming");
    expect(row.content).toBe("a".repeat(3000));
    expect(chat.app.sessions.byId(sessionId)!.revision).toBe(1);
    // the detail carries the live tail with what the checkpoint may lag
    script.content("b");
    await tick();
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const body = await res.json();
    expect(body.live.content).toBe(`${"a".repeat(3000)}b`);
    expect(body.session.revision).toBe(1);
    script.reply(" done");
  });
});

describe("finalizeSend", () => {
  test("writes the reply's end, the usage and the send's end in one revision", async () => {
    const chat = await chatApp();
    const { seen, stop } = envelopes();
    try {
      const { detail, script, sessionId } = await startChat(chat);
      script.reasoning("thinking");
      script.content("Hi **there**");
      script.finish();
      script.usage({ prompt: 12, completion: 7 });
      script.end();
      await tick();
      await tick();
      const session = chat.app.sessions.byId(sessionId)!;
      expect(session.status).toBe("done");
      expect(session.revision).toBe(2);
      const reply = chat.app.sessions.message(detail.messages[1].id)!;
      expect(reply).toMatchObject({
        status: "done",
        content: "Hi **there**",
        reasoning: "thinking",
        finishReason: "stop",
        error: null,
      });
      expect(reply.html).toContain("<strong");
      expect(reply.finishedAt).not.toBeNull();
      const send = chat.app.sessions.send(detail.send.id)!;
      expect(send).toMatchObject({
        status: "done",
        cause: "finish",
        error: null,
      });
      expect(chat.app.usage.forSession(sessionId)).toMatchObject([
        {
          sendId: detail.send.id,
          promptTokens: 12,
          completionTokens: 7,
          round: 1,
        },
      ]);
      expect(seen).toHaveLength(2);
      expect(seen[1].session.revision).toBe(2);
      expect(seen[1].messages.map((m) => m.id)).toEqual([reply.id]);
      expect(seen[1].send?.status).toBe("done");
      expect(chat.app.runner.registry.size).toBe(0);
    } finally {
      stop();
    }
  });

  test("the rows agree with the lock after a finish, so a second send goes", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    script.reply("one");
    await tick();
    await tick();
    const pending = chat.scripted.next();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      {
        body: { message: "again" },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.messages).toHaveLength(4);
    expect(body.session.revision).toBe(3);
    const second = await pending;
    // the history the model sees: the prompt, then the turns so far
    const roles = (second.body.messages as { role: string }[]).map(
      (m) => m.role,
    );
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    second.reply("two");
  });
});
