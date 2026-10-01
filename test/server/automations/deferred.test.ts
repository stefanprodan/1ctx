// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// During a drain the scheduler fires nothing: a row that comes due, or
// waits for a cap, records a deferred event with its due time and keeps
// next_at, and the next start fires it with the reason on its run.

import { describe, expect, test } from "bun:test";
import { RunCapacity } from "../../../src/server/runner/index.ts";
import { testApp } from "../../helpers/app.ts";
import { createAutomation } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

const BOUND = 10_000;

const setDue = (chat: ChatApp, id: string, at: number) =>
  chat.app.db
    .query("update automations set next_at = ? where id = ?")
    .run(at, id);

const row = (chat: ChatApp, id: string) => chat.app.automations.byId(id)!;

// a chat holds the drain open; the scheduler is driven by hand
async function draining() {
  const chat = await chatApp({ drainMs: BOUND });
  chat.app.automationScheduler.stop();
  await tick();
  const held = await startChat(chat, "busy");
  return {
    chat,
    begin: () => chat.app.shutdown(),
    release: () => held.script.reply("ok"),
  };
}

describe("a drain's scheduler", () => {
  test("a row due inside it starts nothing and records the deferral", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const due = chat.app.now.value;
    setDue(chat, automation.id, due);
    const done = begin();
    await chat.app.automationScheduler.pass();
    await chat.app.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(1);
    const deferred = row(chat, automation.id);
    expect(deferred).toMatchObject({
      nextAt: due,
      lastEventOutcome: "deferred",
      lastEventSource: "schedule",
      lastEventDueAt: due,
      lastEventReason: "restarting",
      lastRunSessionId: null,
    });
    release();
    await done;
    expect(row(chat, automation.id).revision).toBe(deferred.revision);
  });

  test("a fire during it starts nothing and records the deferral", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const due = chat.app.now.value;
    setDue(chat, automation.id, due);
    const done = begin();
    expect(await chat.app.automationScheduler.fire(automation.id)).toBeNull();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(row(chat, automation.id)).toMatchObject({
      nextAt: due,
      lastEventOutcome: "deferred",
      lastEventDueAt: due,
      lastRunSessionId: null,
    });
    release();
    await done;
  });

  test("a row waiting for a cap is deferred too", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const due = chat.app.now.value;
    setDue(chat, automation.id, due);
    const original = chat.app.runner.startRun;
    let calls = 0;
    chat.app.runner.startRun = () => {
      calls++;
      throw new RunCapacity("process", "Too many chats and runs are going.");
    };
    await chat.app.automationScheduler.pass();
    expect(calls).toBe(1);
    expect(row(chat, automation.id).lastEventOutcome).toBeNull();
    const done = begin();
    await chat.app.automationScheduler.pass();
    expect(calls).toBe(1);
    expect(row(chat, automation.id)).toMatchObject({
      nextAt: due,
      lastEventOutcome: "deferred",
      lastEventDueAt: due,
    });
    chat.app.runner.startRun = original;
    release();
    await done;
  });

  test("a row due after the drain records nothing", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const later = chat.app.now.value + BOUND + 1;
    setDue(chat, automation.id, later);
    const done = begin();
    await chat.app.automationScheduler.pass();
    release();
    await done;
    expect(row(chat, automation.id)).toMatchObject({
      nextAt: later,
      lastEventAt: null,
    });
  });

  test("the next start fires a deferred row with the reason on its run", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const due = chat.app.now.value;
    setDue(chat, automation.id, due);
    const done = begin();
    await chat.app.automationScheduler.pass();
    release();
    await done;

    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
    });
    const script = await waitScript(chat.scripted, 2);
    const fired = next.automations.byId(automation.id)!;
    expect(fired).toMatchObject({
      lastEventOutcome: "run",
      lastEventSource: "schedule",
      lastEventDueAt: due,
      lastEventReason: "deferred by a restart",
    });
    expect(fired.nextAt).toBeGreaterThan(due);
    script.reply("done");
    for (let i = 0; i < 100; i++) {
      if (next.sessions.byId(fired.lastRunSessionId!)?.status !== "running") {
        break;
      }
      await tick();
    }
    await next.shutdown();
  });

  test("a row deferred and then suspended is skipped for that at the next start", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const due = chat.app.now.value;
    setDue(chat, automation.id, due);
    const done = begin();
    await chat.app.automationScheduler.pass();
    // the listener serves through the drain
    const suspend = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    expect(suspend.status).toBe(200);
    release();
    await done;

    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
    });
    await next.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(1);
    const member = next.client();
    await member.login("casey", "pw");
    const resumed = await member.call(
      "POST",
      `/api/automations/${automation.id}/resume`,
    );
    expect(resumed.status).toBe(200);
    const nextAt = next.automations.byId(automation.id)!.nextAt!;
    next.now.value = nextAt;
    const pending = chat.scripted.next();
    await next.automationScheduler.pass();
    const script = await pending;
    const fired = next.automations.byId(automation.id)!;
    expect(fired).toMatchObject({
      lastEventOutcome: "run",
      lastEventDueAt: nextAt,
      lastEventReason: null,
    });
    script.reply("done");
    const session = fired.lastRunSessionId!;
    for (let i = 0; i < 100; i++) {
      if (next.sessions.byId(session)?.status !== "running") break;
      await tick();
    }
    await next.shutdown();
  });

  test("Run now during the drain is refused and writes nothing", async () => {
    const { chat, begin, release } = await draining();
    const automation = await createAutomation(chat);
    const before = row(chat, automation.id);
    const done = begin();
    const res = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    expect(res.status).toBe(503);
    expect(row(chat, automation.id)).toEqual(before);
    release();
    await done;
  });
});
