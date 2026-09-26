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
import { collectLogs } from "../helpers/app.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";
import { answerNodes } from "../helpers/tool-loop.ts";

describe("the terminal transition", () => {
  test("a provider failure ends the send as failed with the message", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { detail, script, sessionId } = await startChat(chat);
    script.content("so far");
    chat.app.now.value += 25;
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
    expect(logs.events.find((event) => event.msg === "send start")).toEqual({
      level: "info",
      area: "runner",
      msg: "send start",
      fields: {
        chat: sessionId,
        user: "casey",
        agent: "coder",
        provider: "local",
        model: expect.any(String),
        op: "message",
      },
    });
    expect(logs.events.find((event) => event.msg === "round failed")).toEqual({
      level: "warn",
      area: "runner",
      msg: "round failed",
      fields: {
        chat: sessionId,
        round: 1,
        error_type: "Error",
        error: "stream ended early",
      },
    });
    expect(logs.events.find((event) => event.msg === "send end")).toEqual({
      level: "error",
      area: "runner",
      msg: "send end",
      fields: {
        chat: sessionId,
        op: "message",
        cause: "failure",
        status: "failed",
        rounds: 1,
        tools: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        spent_tokens: 0,
        duration: 25,
        error_type: "exception",
        error: "stream ended early",
      },
    });
  });

  test("a completed send reports rounds, tools and token kinds", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { script, sessionId } = await startChat(chat, "use time");
    script.toolRound(
      [
        {
          id: "time",
          name: "datetime",
          arguments: '{"timezone":"UTC"}',
        },
      ],
      { prompt: 11, completion: 2 },
    );
    script.end();
    const answer = await waitScript(chat.scripted, 2);
    answer.content("done");
    answer.finish();
    answer.usage({ prompt: 17, completion: 3 });
    answer.end();
    await tick();
    await tick();
    expect(logs.events.findLast((event) => event.msg === "send end")).toEqual({
      level: "info",
      area: "runner",
      msg: "send end",
      fields: {
        chat: sessionId,
        op: "message",
        cause: "finish",
        status: "done",
        rounds: 2,
        tools: 1,
        prompt_tokens: 28,
        completion_tokens: 5,
        spent_tokens: 33,
        duration: 0,
      },
    });
  });

  // a refused request is a failure with the provider's words, and it is
  // never asked again
  test.each([
    [429, '{"error":{"message":"slow down"}}'],
    [500, "down"],
  ])(
    "a refused request (%i) fails once with its words",
    async (status, body) => {
      const chat = await chatApp();
      chat.scripted.refuse(status, body);
      const res = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "x",
        },
      });
      expect(res.status).toBe(201);
      const { session, send } = await res.json();
      await tick();
      await tick();
      expect(chat.scripted.chats()).toBe(1);
      expect(chat.app.sessions.send(send.id)!).toMatchObject({
        status: "failed",
        cause: "failure",
        error: `HTTP ${status}: ${body}`,
      });
      expect(chat.app.sessions.byId(session.id)!.status).toBe("failed");
    },
  );

  test("a request with no answer is asked again once", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.drop(1);
    const { script, detail } = await startChat(chat);
    script.reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    const retried = logs.events.filter((e) => e.msg === "round retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.level).toBe("warn");
    expect(retried[0]!.fields).toMatchObject({
      round: 1,
      error_type: "Error",
    });
  });

  test("a second request with no answer fails the round, no third", async () => {
    const chat = await chatApp();
    chat.scripted.drop(5);
    const res = await chat.member.call("POST", "/api/sessions", {
      body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
    });
    const { send } = await res.json();
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(send.id)!).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "local failed: the connection was reset",
    });
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
    const result = await chat.app.shutdown();
    expect(result).toEqual({ ended: 2, timedOut: false });
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
    answerNodes(chat, sessionId);
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
