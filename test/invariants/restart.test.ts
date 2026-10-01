// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A restart drains: from the first signal nothing new starts, a message
// to a chat waits for the next start, and the running sends have the
// bound to end on their own before what is left is terminated.

import { describe, expect, test } from "bun:test";
import { Registry } from "../../src/server/runner/registry.ts";
import { shutdownRunner } from "../../src/server/runner/shutdown.ts";
import { collectLogs, testApp } from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  startChat,
  tick,
} from "../helpers/chat.ts";

const BOUND = 10_000;

const message = (chat: ChatApp, sessionId: string, text: string) =>
  chat.member.call("POST", `/api/sessions/${sessionId}/messages`, {
    body: { message: text },
  });

// a chat whose turn has ended
async function idleChat(chat: ChatApp, text = "first") {
  const started = await startChat(chat, text);
  started.script.reply("done");
  for (let i = 0; i < 100; i++) {
    if (chat.app.runner.registry.get(started.sessionId) === null) break;
    await tick();
  }
  return started.sessionId;
}

describe("a drain", () => {
  test("a send that finishes inside the bound ends done, nothing terminated", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ drainMs: BOUND, logFactory: logs.logFactory });
    const { detail, script } = await startChat(chat);
    const done = chat.app.shutdown();
    await tick();
    script.reply("answer");
    expect(await done).toEqual({ ended: 0, timedOut: false, drained: 1 });
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      cause: "finish",
    });
    const said = logs.events
      .filter((e) => e.area === "runner" && e.msg.startsWith("drain"))
      .map(({ msg, fields }) => ({ msg, fields }));
    expect(said).toEqual([
      { msg: "draining", fields: { sends: 1, asks: 0, bound: BOUND } },
      { msg: "drained", fields: { sends: 1, duration: 0 } },
    ]);
  });

  test("one past the bound is terminated with cause shutdown at the bound", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ drainMs: BOUND, logFactory: logs.logFactory });
    const { detail, script } = await startChat(chat);
    const done = chat.app.shutdown();
    await tick();
    expect(chat.app.sessions.send(detail.send.id)?.status).toBe("running");
    chat.app.now.value += BOUND;
    expect(await done).toEqual({ ended: 1, timedOut: false, drained: 0 });
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "stopped",
      cause: "shutdown",
    });
    expect(script.aborted).toBe(true);
    expect(logs.events.find((e) => e.msg === "drain over")?.fields).toEqual({
      drained: 0,
      terminated: 1,
      duration: BOUND,
    });
  });

  test("a drain of zero terminates at once and says nothing", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const { detail } = await startChat(chat);
    expect(await chat.app.shutdown()).toEqual({
      ended: 1,
      timedOut: false,
      drained: 0,
    });
    expect(chat.app.sessions.send(detail.send.id)?.cause).toBe("shutdown");
    expect(logs.events.some((e) => e.msg.startsWith("drain"))).toBe(false);
  });

  test("with nothing running it ends at once and says nothing", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ drainMs: BOUND, logFactory: logs.logFactory });
    expect(await chat.app.shutdown()).toEqual({
      ended: 0,
      timedOut: false,
      drained: 0,
    });
    expect(logs.events.some((e) => e.msg.startsWith("drain"))).toBe(false);
  });

  test("a second signal ends the wait early", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ drainMs: BOUND, logFactory: logs.logFactory });
    const { detail } = await startChat(chat);
    let cut = () => {};
    const second = new Promise<void>((resolve) => {
      cut = resolve;
    });
    const done = chat.app.shutdown(second);
    await tick();
    cut();
    expect(await done).toEqual({ ended: 1, timedOut: false, drained: 0 });
    expect(chat.app.sessions.send(detail.send.id)?.cause).toBe("shutdown");
    expect(logs.events.find((e) => e.msg === "drain over")?.fields).toEqual({
      drained: 0,
      terminated: 1,
      duration: 0,
    });
  });

  test("what cannot wait is a 503 with the server's words", async () => {
    const chat = await chatApp({ drainMs: BOUND });
    const idle = await idleChat(chat);
    const automation = await createAutomation(chat);
    const running = await startChat(chat, "busy");
    const done = chat.app.shutdown();
    await tick();
    const refusals = [
      await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "x",
        },
      }),
      await chat.member.call("POST", `/api/sessions/${idle}/regenerate`, {
        body: {},
      }),
      await chat.member.call("POST", `/api/sessions/${idle}/compact`),
      await chat.member.call("POST", `/api/automations/${automation.id}/run`),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "the server is restarting" });
    }
    running.script.reply("ok");
    await done;
  });

  test("a message to an idle chat and to a busy one is queued and sent at the next start", async () => {
    const chat = await chatApp({ drainMs: BOUND });
    const idle = await idleChat(chat);
    const busy = await startChat(chat, "busy");
    const done = chat.app.shutdown();
    await tick();
    const toIdle = await message(chat, idle, "for later");
    const toBusy = await message(chat, busy.sessionId, "after that");
    expect(toIdle.status).toBe(202);
    expect(toBusy.status).toBe(202);
    // the turn that ends starts nothing
    busy.script.reply("ok");
    expect(await done).toEqual({ ended: 0, timedOut: false, drained: 1 });
    expect(chat.scripted.scripts).toHaveLength(2);
    const queued = () =>
      chat.app.db
        .query<{ session_id: string; state: string }, []>(
          "select session_id, state from queued_messages order by session_id",
        )
        .all();
    expect(queued()).toHaveLength(2);
    expect(queued().every((row) => row.state === "queued")).toBe(true);

    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
    });
    for (let i = 0; i < 100 && chat.scripted.scripts.length < 4; i++) {
      await tick();
    }
    expect(chat.scripted.scripts).toHaveLength(4);
    const sent = chat.scripted.scripts
      .slice(2)
      .map((s) => JSON.stringify(s.body.messages));
    expect(sent.some((m) => m.includes("for later"))).toBe(true);
    expect(sent.some((m) => m.includes("after that"))).toBe(true);
    expect(queued()).toEqual([]);
    for (const script of chat.scripted.scripts.slice(2)) script.reply("ok");
    await next.shutdown();
  });

  test("a summon is queued alike", async () => {
    const chat = await chatApp({ drainMs: BOUND });
    await chat.makeAgent({ name: "checker", model: FLASH });
    const idle = await idleChat(chat);
    const busy = await startChat(chat, "busy");
    const done = chat.app.shutdown();
    await tick();
    expect((await message(chat, idle, "@checker look")).status).toBe(202);
    expect((await message(chat, idle, "@nobody look")).status).toBe(400);
    busy.script.reply("ok");
    await done;
    expect(
      chat.app.db.query("select content, state from queued_messages").all(),
    ).toEqual([{ content: "@checker look", state: "queued" }]);
  });

  test("health says draining and ready turns 503 from the first signal", async () => {
    const chat = await chatApp({ drainMs: BOUND });
    const anonymous = chat.app.client();
    const health = async () =>
      (await anonymous.call("GET", "/api/health")).json();
    expect(await health()).toEqual({
      ok: true,
      version: "v0.0.0-test",
      draining: false,
    });
    const before = await anonymous.call("GET", "/api/ready");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ ready: true });
    const running = await startChat(chat);
    const done = chat.app.shutdown();
    const during = await anonymous.call("GET", "/api/health");
    expect(during.status).toBe(200);
    expect(await during.json()).toMatchObject({ ok: true, draining: true });
    const ready = await anonymous.call("GET", "/api/ready");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, reason: "draining" });
    running.script.reply("ok");
    await done;
    expect((await anonymous.call("GET", "/api/ready")).status).toBe(503);
  });
});

describe("the wait after the drain", () => {
  test("a hung close does not hold the exit past it", async () => {
    let now = 0;
    const sleepers: { at: number; resolve: () => void }[] = [];
    const clock = Object.assign(() => now, {
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          sleepers.push({ at: now + ms, resolve });
        }),
    });
    let closed = false;
    const done = shutdownRunner(
      new Registry(),
      clock,
      () => {},
      5000,
      async () => {},
      () => {
        closed = true;
        return new Promise<void>(() => {});
      },
    );
    await tick();
    expect(closed).toBe(true);
    now = 5000;
    for (const sleeper of sleepers) sleeper.resolve();
    expect(await done).toEqual({ ended: 0, timedOut: true });
  });

  test("a close the streams never reach still starts at the deadline", async () => {
    const sleepers: (() => void)[] = [];
    const clock = Object.assign(() => 0, {
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepers.push(resolve);
        }),
    });
    let closed = false;
    const done = shutdownRunner(
      new Registry(),
      clock,
      () => {},
      5000,
      () => new Promise<void>(() => {}),
      async () => {
        closed = true;
      },
    );
    await tick();
    expect(closed).toBe(false);
    for (const resolve of sleepers) resolve();
    expect(await done).toEqual({ ended: 0, timedOut: true });
    expect(closed).toBe(true);
  });
});
