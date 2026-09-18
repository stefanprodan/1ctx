// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The terminal transition: a send ends once, for the first cause named,
// and finalizeSend runs exactly once whatever races with it. Every
// cause has its status and its rows.

import { describe, expect, test } from "bun:test";
import { FINALIZE_RETRY_MS } from "../../src/server/runner/index.ts";
import {
  MAX_REPLY_BYTES,
  STREAM_IDLE_MS,
} from "../../src/server/runner/round.ts";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

describe("the terminal transition", () => {
  test("a provider failure ends the send as failed with the message", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    script.content("so far");
    script.end();
    await tick();
    await tick();
    const reply = chat.app.sessions.message(detail.messages[1].id)!;
    expect(reply.status).toBe("failed");
    expect(reply.content).toBe("so far");
    expect(reply.error).toBe("stream ended early");
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "failed", cause: "failure" });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("failed");
    expect(chat.app.runner.registry.size).toBe(0);
  });

  test("a refused request is a failure with the provider's words, and no key", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(429, '{"error":{"message":"slow down"}}');
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    expect(res.status).toBe(201);
    const { session, send } = await res.json();
    await tick();
    await tick();
    expect(chat.app.sessions.send(send.id)!).toMatchObject({
      status: "failed",
      cause: "failure",
      error: 'HTTP 429: {"error":{"message":"slow down"}}',
    });
    expect(chat.app.sessions.byId(session.id)!.status).toBe("failed");
  });

  test("a stop that races a finish ends the send once", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    const store = chat.app.sessions;
    let finalized = 0;
    const original = store.finishSend.bind(store);
    store.finishSend = (id, fields) => {
      finalized++;
      return original(id, fields);
    };
    try {
      script.content("x");
      script.finish();
      script.usage();
      script.end();
      // the stop lands while the finish is being read
      await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
      await tick();
      await tick();
    } finally {
      store.finishSend = original;
    }
    expect(finalized).toBe(1);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(["stop", "finish"]).toContain(send.cause ?? "");
    expect(chat.app.sessions.byId(sessionId)!.status).toBe(send.status);
    expect(chat.app.runner.registry.size).toBe(0);
  });

  test("shutdown ends every send as stopped by shutdown and waits for the streams", async () => {
    const chat = await chatApp();
    const a = await startChat(chat, "a");
    const b = await startChat(chat, "b");
    a.script.content("a1");
    await tick();
    await chat.app.shutdown();
    for (const { detail } of [a, b]) {
      expect(chat.app.sessions.send(detail.send.id)!).toMatchObject({
        status: "stopped",
        cause: "shutdown",
      });
      expect(chat.app.sessions.message(detail.messages[1].id)!.status).toBe(
        "stopped",
      );
    }
    expect(chat.app.sessions.message(a.detail.messages[1].id)!.content).toBe(
      "a1",
    );
    expect(a.script.aborted).toBe(true);
    expect(chat.app.runner.registry.size).toBe(0);
  });

  test("a provider quiet after its first event fails after the inactivity deadline", async () => {
    const chat = await chatApp();
    const { detail, script } = await startChat(chat);
    script.content("partial");
    await tick();
    await tick();
    chat.app.now.value += STREAM_IDLE_MS;
    await tick();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "the provider went quiet",
    });
    expect(script.aborted).toBe(true);
  });

  test("a provider reading a long prompt is waited for past the inactivity deadline", async () => {
    const chat = await chatApp();
    const { detail, script } = await startChat(chat);
    await tick();
    // a local server says nothing while it reads the prompt
    chat.app.now.value += STREAM_IDLE_MS * 3;
    await tick();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)?.status).toBe("running");
    script.reply("read it");
    await tick();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      cause: "finish",
    });
  });

  test("a reply over one megabyte fails at the cap", async () => {
    const chat = await chatApp();
    const { detail, script } = await startChat(chat);
    const half = Math.floor(MAX_REPLY_BYTES / 2);
    script.reasoning("x".repeat(half));
    script.content("y".repeat(MAX_REPLY_BYTES - half + 1));
    await tick();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "the reply exceeded 1 MB",
    });
    expect(script.aborted).toBe(true);
  });

  test("a stop during a work round ends the send once, work reply and any tool row stopped", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "when");
    const store = chat.app.sessions;
    let finalized = 0;
    const original = store.finishSend.bind(store);
    store.finishSend = (id, fields) => {
      finalized++;
      return original(id, fields);
    };
    try {
      // narration then the first call delta moves the reply into the
      // fold; the stop lands before the calls assemble
      script.content("let me check the clock");
      script.toolCall({
        id: "c1",
        name: "datetime",
        arguments: '{"timezone":"UTC"}',
      });
      await tick();
      await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
      await tick();
      await tick();
    } finally {
      store.finishSend = original;
    }
    expect(finalized).toBe(1);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "stopped", cause: "stop" });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("stopped");
    // the work reply it ended keeps the work slot (marked before the stop)
    const reply = chat.app.sessions.message(detail.messages[1].id)!;
    expect(reply.slot).toBe("work");
    expect(reply.status).toBe("stopped");
    expect(chat.app.runner.registry.size).toBe(0);
    expect(script.aborted).toBe(true);
    chat.app.socket.dispose();
  });

  test("a failed finalize keeps the running rows locked", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    const store = chat.app.sessions;
    const original = store.finishSend.bind(store);
    let attempts = 0;
    store.finishSend = () => {
      attempts++;
      throw new Error("disk full");
    };
    try {
      script.reply("x");
      await tick();
      chat.app.now.value += FINALIZE_RETRY_MS;
      await tick();
      chat.app.now.value += FINALIZE_RETRY_MS;
      await tick();
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/messages`,
        { body: { message: "again" } },
      );
      expect(res.status).toBe(409);
    } finally {
      store.finishSend = original;
    }
    expect(attempts).toBe(3);
    expect(chat.app.runner.registry.get(sessionId)).not.toBeNull();
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("running");
    const running = chat.app.db
      .query(
        "select count(*) as count from sends where session_id = ? and status = 'running'",
      )
      .get(sessionId) as { count: number };
    expect(running.count).toBe(1);
  });
});
