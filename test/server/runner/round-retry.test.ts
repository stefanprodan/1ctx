// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A round asks a busy or unreachable provider again: through the whole
// app with the scripted provider, and through runRound alone for what
// the scripted fetch cannot make, a headers wait that ran out.

import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../../../src/server/providers/index.ts";
import {
  type RoundDeps,
  runRound,
  STREAM_IDLE_MS,
} from "../../../src/server/runner/round.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { collectLogs } from "../../helpers/app.ts";
import { type ChatApp, chatApp, tick, waitScript } from "../../helpers/chat.ts";

const BUSY = '{"error":{"message":"busy"}}';

async function post(chat: ChatApp) {
  const res = await chat.member.call("POST", "/api/sessions", {
    body: { projectId: chat.projectId, agentId: chat.agentId, message: "x" },
  });
  expect(res.status).toBe(201);
  const { session, send } = await res.json();
  await tick();
  return { sessionId: session.id as string, sendId: send.id as string };
}

// past the longest backoff with its jitter
async function advance(chat: ChatApp, ms = 5000) {
  await tick();
  chat.app.now.value += ms;
  await tick();
  await tick();
}

describe("provider retries through a turn", () => {
  test("a 503 then an answer finishes the turn with one warning", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(503, BUSY, { times: 1 });
    const { sendId, sessionId } = await post(chat);
    expect(chat.scripted.chats()).toBe(1);
    await advance(chat);
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    const retried = logs.events.filter((e) => e.msg === "round retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ level: "warn", area: "runner" });
    expect(retried[0]!.fields).toEqual({
      chat: sessionId,
      round: 1,
      attempt: 1,
      status: 503,
      wait: expect.any(Number),
    });
    const wait = retried[0]!.fields.wait as number;
    expect(wait).toBeGreaterThanOrEqual(1000);
    expect(wait).toBeLessThanOrEqual(1250);
  });

  test.each([
    [429, BUSY],
    [500, "down"],
    [502, "bad gateway"],
    [503, BUSY],
    [504, "timeout"],
  ])(
    "four refusals (%i) fail the turn with the last words",
    async (status, body) => {
      const logs = collectLogs();
      const chat = await chatApp({ logFactory: logs.logFactory });
      chat.scripted.refuse(status, body);
      const { sendId, sessionId } = await post(chat);
      for (let i = 0; i < 3; i++) await advance(chat);
      await tick();
      expect(chat.scripted.chats()).toBe(4);
      expect(chat.app.sessions.send(sendId)!).toMatchObject({
        status: "failed",
        cause: "failure",
        error: `HTTP ${status}: ${body}`,
      });
      expect(chat.app.sessions.byId(sessionId)!.status).toBe("failed");
      const attempts = logs.events
        .filter((e) => e.msg === "round retried")
        .map((e) => e.fields.attempt);
      expect(attempts).toEqual([1, 2, 3]);
    },
  );

  test("a 429 with Retry-After waits that long on the clock", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(429, BUSY, {
      times: 1,
      headers: { "retry-after": "2" },
    });
    const { sendId } = await post(chat);
    await tick();
    chat.app.now.value += 1999;
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    chat.app.now.value += 1;
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    expect(
      logs.events.find((e) => e.msg === "round retried")!.fields,
    ).toMatchObject({ status: 429, wait: 2000 });
  });

  test("a Retry-After past 30 s fails the turn at once", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(429, BUSY, { headers: { "retry-after": "31" } });
    const { sendId } = await post(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: `HTTP 429: ${BUSY}`,
    });
  });

  test("Stop during a wait ends the turn at once", async () => {
    const chat = await chatApp();
    chat.scripted.refuse(503, BUSY);
    const { sendId, sessionId } = await post(chat);
    await tick();
    const stop = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/stop`,
    );
    expect(stop.status).toBe(200);
    await tick();
    await tick();
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "stopped",
      cause: "stop",
    });
    await advance(chat, 60_000);
    expect(chat.scripted.chats()).toBe(1);
  });

  test("a 400 fails the turn at once", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.refuse(400, '{"error":{"message":"bad request"}}');
    const { sendId } = await post(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: 'HTTP 400: {"error":{"message":"bad request"}}',
    });
    expect(logs.events.some((e) => e.msg === "round retried")).toBe(false);
  });

  test("an error after the first content fails the turn at once", async () => {
    const chat = await chatApp();
    const { sendId } = await post(chat);
    const script = await waitScript(chat.scripted, 1);
    script.content("so far");
    script.sse(
      `data: ${JSON.stringify({ error: { code: 503, message: "busy" } })}\n\n`,
    );
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(1);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      error: "busy",
    });
  });

  test("an error frame before any event is asked again", async () => {
    const chat = await chatApp();
    const { sendId } = await post(chat);
    const first = await waitScript(chat.scripted, 1);
    first.sse(
      `data: ${JSON.stringify({
        error: { code: 503, message: "overloaded", status: "UNAVAILABLE" },
      })}\n\n`,
    );
    first.end();
    await advance(chat);
    (await waitScript(chat.scripted, 2)).reply("hello");
    await tick();
    await tick();
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
  });

  test("a failed connection is asked again", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    chat.scripted.drop(1);
    const { sendId } = await post(chat);
    await advance(chat);
    (await waitScript(chat.scripted, 1)).reply("hello");
    await tick();
    await tick();
    expect(chat.scripted.chats()).toBe(2);
    expect(chat.app.sessions.send(sendId)!.status).toBe("done");
    const retried = logs.events.filter((e) => e.msg === "round retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.fields).toMatchObject({
      round: 1,
      attempt: 1,
      error_type: "Error",
      error: "local failed: the connection was reset",
    });
  });

  test("four failed connections fail the round", async () => {
    const chat = await chatApp();
    chat.scripted.drop(9);
    const { sendId } = await post(chat);
    for (let i = 0; i < 3; i++) await advance(chat);
    await tick();
    expect(chat.scripted.chats()).toBe(4);
    expect(chat.app.sessions.send(sendId)!).toMatchObject({
      status: "failed",
      cause: "failure",
      error: "local failed: the connection was reset",
    });
  });
});

// runRound alone, with a chat port that plays one stream per request
function round(
  streams: ChatEvent[][],
  fields: { deadline?: number | null } = {},
) {
  const logs = collectLogs();
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock = Object.assign(() => now, {
    // a retry's wait passes at once; the quiet timer never fires
    sleep: (ms: number) => {
      if (ms >= STREAM_IDLE_MS) return new Promise<void>(() => {});
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  let asked = 0;
  const deps = {
    chat: () => {
      const events = streams[asked++] ?? [];
      return (async function* () {
        yield* events;
      })();
    },
    writer: { delta() {} },
    lookups: {},
    clock,
    log: logs.logFactory("runner"),
    random: () => 0,
  } as unknown as RoundDeps;
  const send = {
    sessionId: "chat",
    roundNo: 1,
    phase: "provider",
    kind: "chat",
    summarizing: false,
    answering: null,
    startedAt: now,
    controller: new AbortController(),
    policy: {
      providerId: "p",
      deadlineMs: null,
      offered: { tools: [] },
    },
    round: { content: "", reasoning: "", finishReason: null, usage: null },
  } as unknown as ActiveSend;
  const run = runRound(deps, send, [], {
    request: { model: "m", messages: [], thinking: false },
    ...(fields.deadline === undefined ? {} : { deadline: fields.deadline }),
  });
  return { run, asked: () => asked, sleeps, logs, send };
}

const timedOut: ChatEvent = {
  kind: "error",
  message: "local failed: the response headers timed out",
  unanswered: true,
  timedOut: true,
};
const busy: ChatEvent = { kind: "error", message: "HTTP 503", status: 503 };
const answer: ChatEvent[] = [
  { kind: "content", text: "hi" },
  { kind: "finish", reason: "stop", details: null },
];

describe("runRound retries", () => {
  test("two headers timeouts fail the round", async () => {
    const r = round([[timedOut], [timedOut], answer]);
    await expect(r.run).rejects.toThrow(
      "local failed: the response headers timed out",
    );
    expect(r.asked()).toBe(2);
    expect(r.sleeps).toEqual([1000]);
  });

  test("a headers timeout counts toward the three", async () => {
    const r = round([[timedOut], [busy], [busy], [busy], answer]);
    await expect(r.run).rejects.toThrow("HTTP 503");
    expect(r.asked()).toBe(4);
    expect(r.sleeps).toEqual([1000, 2000, 4000]);
  });

  test("a third retry answered finishes the round", async () => {
    const r = round([[busy], [busy], [busy], answer]);
    await r.run;
    expect(r.asked()).toBe(4);
    expect(r.send.round!.finishReason).toBe("stop");
  });

  test("a wait past the deadline is not started", async () => {
    const r = round([[busy], answer], { deadline: 1_000_000 + 1000 });
    await expect(r.run).rejects.toThrow("HTTP 503");
    expect(r.asked()).toBe(1);
    expect(r.sleeps).toEqual([]);
  });
});
