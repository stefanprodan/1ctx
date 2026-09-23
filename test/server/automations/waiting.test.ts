// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled fire the run pool refuses stays due and starts once a
// slot frees: over the real runner with a low run cap, and over a fake
// start that refuses on cue.

import { describe, expect, test } from "bun:test";
import { type Event, RunCapacity } from "../../../src/server/runner/index.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { collectLogs, testApp } from "../../helpers/app.ts";
import {
  automationBody,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

const HOUR = 3_600_000;
const FAR = 1000 * HOUR;

const setDue = (chat: ChatApp, id: string, at: number) =>
  chat.app.db
    .query("update automations set next_at = ? where id = ?")
    .run(at, id);

const row = (chat: ChatApp, id: string) => chat.app.automations.byId(id)!;

// the runner's start wrapped: every call recorded, and a full pool
// thrown while full() names one
function fakeStart(
  chat: ChatApp,
  full: (event: Event) => "user" | "process" | null,
) {
  const calls: string[] = [];
  const original = chat.app.runner.startRun;
  chat.app.runner.startRun = (event) => {
    calls.push(event.automation.id);
    const pool = full(event);
    if (pool === "user") {
      throw new RunCapacity(
        "user",
        "1 of your tasks are running; wait for one",
      );
    }
    if (pool === "process") {
      throw new RunCapacity(
        "process",
        "too many tasks running; try again in a moment",
      );
    }
    return original(event);
  };
  return {
    calls,
    restore() {
      chat.app.runner.startRun = original;
    },
  };
}

async function adminAutomation(
  chat: ChatApp,
  name: string,
): Promise<AutomationSummary> {
  const project = chat.app.projects.personal(chat.adminId)!.id;
  const response = await chat.admin.call(
    "POST",
    `/api/projects/${project}/automations`,
    { body: automationBody(chat, { name }) },
  );
  expect(response.status).toBe(201);
  return (await response.json()).automation;
}

// a run of the member's that holds its only slot
async function holdSlot(chat: ChatApp) {
  await setLimits(chat, { runsPerUser: 1 });
  const holder = await createAutomation(chat, { name: "holder" });
  setDue(chat, holder.id, FAR);
  return startRun(chat, holder.id);
}

async function stopped() {
  const logs = collectLogs();
  const chat = await chatApp({ logFactory: logs.logFactory });
  chat.app.automationScheduler.stop();
  await tick();
  return { chat, logs };
}

const waits = (logs: ReturnType<typeof collectLogs>) =>
  logs.events
    .filter((event) => event.msg === "wait")
    .map((event) => event.fields);

describe("a fire waiting for a run slot", () => {
  test("a full pool leaves the row due with nothing written, logged once", async () => {
    const { chat, logs } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);
    const before = row(chat, waiting.id);

    await chat.app.automationScheduler.pass();
    expect(row(chat, waiting.id)).toEqual(before);
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(waits(logs)).toEqual([{ automation: waiting.id, pool: "user" }]);

    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    expect(row(chat, waiting.id)).toEqual(before);
    expect(waits(logs)).toHaveLength(1);
    expect(logs.events.some((event) => event.msg === "skip")).toBe(false);

    held.main.reply("done");
    await settleRun(chat, held.sessionId);
    await chat.app.shutdown();
  });

  test("a freed slot starts it with its missed due time", async () => {
    const { chat } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);

    chat.app.automationScheduler.start();
    await tick();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(row(chat, waiting.id).nextAt).toBe(due);

    held.main.reply("done");
    await settleRun(chat, held.sessionId);
    const script = await waitScript(chat.scripted, 2);
    expect(row(chat, waiting.id)).toMatchObject({
      lastEventOutcome: "run",
      lastEventSource: "schedule",
      lastEventDueAt: due,
      nextAt: HOUR,
    });
    script.reply("done");
    await settleRun(chat, row(chat, waiting.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("a missed occurrence is one skip and the newest past one is tried", async () => {
    const { chat, logs } = await stopped();
    const waiting = await createAutomation(chat, { name: "waiting" });
    const first = chat.app.now.value;
    setDue(chat, waiting.id, first);
    let full = true;
    const start = fakeStart(chat, () => (full ? "user" : null));

    await chat.app.automationScheduler.pass();
    expect(row(chat, waiting.id).nextAt).toBe(first);

    chat.app.now.value = 2 * HOUR + 60_000;
    await chat.app.automationScheduler.pass();
    expect(row(chat, waiting.id)).toMatchObject({
      lastEventOutcome: "skipped",
      lastEventReason: "still waiting",
      lastEventDueAt: first,
      nextAt: 2 * HOUR,
    });
    expect(
      logs.events
        .filter((event) => event.msg === "skip")
        .map((event) => event.fields),
    ).toEqual([{ automation: waiting.id, reason: "still waiting" }]);
    // blocked since the first pass, so the newest was not tried yet
    expect(start.calls).toEqual([waiting.id]);

    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    expect(start.calls).toEqual([waiting.id, waiting.id]);
    expect(waits(logs)).toEqual([
      { automation: waiting.id, pool: "user" },
      { automation: waiting.id, pool: "user" },
    ]);

    full = false;
    const pending = chat.scripted.next();
    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    expect(row(chat, waiting.id)).toMatchObject({
      lastEventOutcome: "run",
      lastEventDueAt: 2 * HOUR,
      nextAt: 3 * HOUR,
    });
    start.restore();
    script.reply("done");
    await settleRun(chat, row(chat, waiting.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("an owner's full pool passes over only that owner's rows", async () => {
    const { chat } = await stopped();
    const now = chat.app.now.value;
    const mine = await createAutomation(chat, { name: "mine-one" });
    const mine2 = await createAutomation(chat, { name: "mine-two" });
    const theirs = await adminAutomation(chat, "theirs");
    setDue(chat, mine.id, now - 3);
    setDue(chat, mine2.id, now - 2);
    setDue(chat, theirs.id, now - 1);
    const start = fakeStart(chat, (event) =>
      event.user.id === chat.memberId ? "user" : null,
    );
    const pending = chat.scripted.next();

    await chat.app.automationScheduler.pass();
    const script = await pending;
    expect(start.calls).toEqual([mine.id, theirs.id]);
    expect(row(chat, mine.id).nextAt).toBe(now - 3);
    expect(row(chat, mine2.id).nextAt).toBe(now - 2);
    expect(row(chat, theirs.id).lastEventOutcome).toBe("run");
    start.restore();
    script.reply("done");
    await settleRun(chat, row(chat, theirs.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("a full process pool ends the pass's fires", async () => {
    const { chat } = await stopped();
    const now = chat.app.now.value;
    const one = await createAutomation(chat, { name: "one" });
    const two = await adminAutomation(chat, "two");
    const three = await createAutomation(chat, { name: "three" });
    setDue(chat, one.id, now - 3);
    setDue(chat, two.id, now - 2);
    setDue(chat, three.id, now - 1);
    const start = fakeStart(chat, () => "process");

    await chat.app.automationScheduler.pass();
    expect(start.calls).toEqual([one.id]);
    await chat.app.automationScheduler.pass();
    expect(start.calls).toEqual([one.id]);
    for (const [id, at] of [
      [one.id, now - 3],
      [two.id, now - 2],
      [three.id, now - 1],
    ] as const) {
      expect(row(chat, id)).toMatchObject({ nextAt: at, lastEventAt: null });
    }
    start.restore();
    await chat.app.shutdown();
  });

  test("oldest first across waiting and due rows, after the replacement", async () => {
    const { chat } = await stopped();
    chat.app.now.value = 10 * HOUR + 10 * 60_000;
    const late = await createAutomation(chat, { name: "late" });
    const early = await createAutomation(chat, { name: "early" });
    const missed = await createAutomation(chat, { name: "missed" });
    setDue(chat, late.id, 10 * HOUR + 5 * 60_000);
    setDue(chat, early.id, 10 * HOUR + 2 * 60_000);
    setDue(chat, missed.id, 8 * HOUR);
    const start = fakeStart(chat, () => "user");
    await chat.app.automationScheduler.pass();
    expect(start.calls).toEqual([missed.id]);
    expect(row(chat, missed.id).nextAt).toBe(10 * HOUR);

    const order: string[] = [];
    start.restore();
    const second = fakeStart(chat, (event) => {
      order.push(event.automation.id);
      return "process";
    });
    // each pass tries the oldest row alone, which then leaves the queue
    for (let i = 0; i < 3; i++) {
      chat.app.automationScheduler.wake();
      await chat.app.automationScheduler.pass();
      setDue(chat, order.at(-1)!, 11 * HOUR);
    }
    expect(order).toEqual([missed.id, early.id, late.id]);
    expect(second.calls).toEqual(order);
    second.restore();
    await chat.app.shutdown();
  });

  test("the loop does not spin while blocked and sleeps until a future row", async () => {
    const { chat } = await stopped();
    const now = chat.app.now.value;
    const blocked = await createAutomation(chat, { name: "blocked" });
    const later = await adminAutomation(chat, "later");
    setDue(chat, blocked.id, now);
    setDue(chat, later.id, now + 100);
    const start = fakeStart(chat, (event) =>
      event.user.id === chat.memberId ? "user" : null,
    );
    chat.app.automationScheduler.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(start.calls).toEqual([blocked.id]);

    const pending = chat.scripted.next();
    chat.app.now.value = now + 100;
    const script = await pending;
    for (let i = 0; i < 5; i++) await tick();
    expect(start.calls).toEqual([blocked.id, later.id]);
    expect(row(chat, blocked.id).nextAt).toBe(now);
    start.restore();
    chat.app.automationScheduler.stop();
    script.reply("done");
    await settleRun(chat, row(chat, later.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("a block no wake clears is tried again after the pass interval", async () => {
    const { chat } = await stopped();
    const now = chat.app.now.value;
    const waiting = await createAutomation(chat, { name: "waiting" });
    setDue(chat, waiting.id, now);
    let refusals = 1;
    const start = fakeStart(chat, () => {
      if (refusals === 0) return null;
      refusals--;
      return "user";
    });
    chat.app.automationScheduler.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(start.calls).toEqual([waiting.id]);
    const pending = chat.scripted.next();
    chat.app.now.value = now + 60_000;
    const script = await pending;
    expect(start.calls).toEqual([waiting.id, waiting.id]);
    expect(row(chat, waiting.id).lastEventDueAt).toBe(now);
    start.restore();
    chat.app.automationScheduler.stop();
    script.reply("done");
    await settleRun(chat, row(chat, waiting.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("a slot freed while the pass runs is not lost", async () => {
    const { chat } = await stopped();
    const due = chat.app.now.value;
    const waiting = await createAutomation(chat, { name: "waiting" });
    setDue(chat, waiting.id, due);
    let refusals = 1;
    const start = fakeStart(chat, () => {
      if (refusals === 0) return null;
      refusals--;
      // the slot frees after the refusal, before the loop sleeps
      queueMicrotask(() => chat.app.automationScheduler.wake());
      return "user";
    });
    chat.app.automationScheduler.start();
    const script = await waitScript(chat.scripted, 1);
    expect(start.calls).toEqual([waiting.id, waiting.id]);
    expect(row(chat, waiting.id)).toMatchObject({
      lastEventOutcome: "run",
      lastEventDueAt: due,
    });
    start.restore();
    chat.app.automationScheduler.stop();
    script.reply("done");
    await settleRun(chat, row(chat, waiting.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("raising the run cap starts a waiting fire", async () => {
    const { chat } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    setDue(chat, waiting.id, chat.app.now.value);
    chat.app.automationScheduler.start();
    await tick();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);

    await setLimits(chat, { runsPerUser: 2 });
    const script = await waitScript(chat.scripted, 2);
    expect(row(chat, waiting.id).lastEventOutcome).toBe("run");
    chat.app.automationScheduler.stop();
    held.main.reply("done");
    script.reply("done");
    await settleRun(chat, held.sessionId);
    await settleRun(chat, row(chat, waiting.id).lastRunSessionId!);
    await chat.app.shutdown();
  });

  test.each(["owner unavailable", "no such agent", "still running"])(
    "a waiting start refused with %s is a skip that moves next_at",
    async (reason) => {
      const { chat } = await stopped();
      const due = chat.app.now.value;
      const waiting = await createAutomation(chat, { name: "waiting" });
      setDue(chat, waiting.id, due);
      const start = fakeStart(chat, () => "user");
      await chat.app.automationScheduler.pass();
      start.restore();
      expect(row(chat, waiting.id).lastEventAt).toBeNull();

      const agents = chat.app.agents;
      const byId = agents.byId;
      let chatting: Awaited<ReturnType<typeof startChat>> | null = null;
      if (reason === "owner unavailable") {
        chat.app.users.setDisabled(chat.memberId, true);
      } else if (reason === "no such agent") {
        agents.byId = () => null;
      } else {
        chatting = await startChat(chat, "stands in for a run");
        chat.app.db
          .query(
            "update sessions set origin = 'automation', automation_id = ? where id = ?",
          )
          .run(waiting.id, chatting.sessionId);
      }
      chat.app.automationScheduler.wake();
      await chat.app.automationScheduler.pass();
      agents.byId = byId;
      expect(row(chat, waiting.id)).toMatchObject({
        lastEventOutcome: "skipped",
        lastEventReason: reason,
        lastEventDueAt: due,
        nextAt: HOUR,
      });
      if (chatting !== null) {
        chatting.script.reply("done");
        await settleRun(chat, chatting.sessionId);
      }
      await chat.app.shutdown();
    },
  );

  test("an edit of the schedule or zone ends a wait, other edits keep it", async () => {
    const { chat } = await stopped();
    const due = chat.app.now.value;
    const waiting = await createAutomation(chat, { name: "waiting" });
    setDue(chat, waiting.id, due);
    const start = fakeStart(chat, () => "user");
    await chat.app.automationScheduler.pass();
    const patch = (body: Record<string, unknown>) =>
      chat.member.call("PATCH", `/api/automations/${waiting.id}`, { body });

    expect((await patch({ instructions: "check again" })).status).toBe(200);
    expect(row(chat, waiting.id).nextAt).toBe(due);
    expect((await patch({ schedule: "0 * * * *", tz: "UTC" })).status).toBe(
      200,
    );
    expect(row(chat, waiting.id).nextAt).toBe(due);
    expect((await patch({ tz: "Asia/Kolkata" })).status).toBe(200);
    expect(row(chat, waiting.id).nextAt).toBe(30 * 60_000);

    setDue(chat, waiting.id, due);
    expect((await patch({ schedule: "15 * * * *" })).status).toBe(200);
    expect(row(chat, waiting.id).nextAt).toBeGreaterThan(due);

    setDue(chat, waiting.id, due);
    await chat.member.call("POST", `/api/automations/${waiting.id}/suspend`);
    expect(row(chat, waiting.id).nextAt).toBeNull();
    await chat.member.call("POST", `/api/automations/${waiting.id}/resume`);
    expect(row(chat, waiting.id).nextAt).toBeGreaterThan(due);

    setDue(chat, waiting.id, due);
    expect(
      (await chat.member.call("DELETE", `/api/automations/${waiting.id}`))
        .status,
    ).toBe(204);
    const calls = start.calls.length;
    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    expect(start.calls).toHaveLength(calls);
    start.restore();
    await chat.app.shutdown();
  });

  test("Run now at a full pool is the 429 and the wait stays", async () => {
    const { chat } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);
    await chat.app.automationScheduler.pass();

    const refused = await chat.member.call(
      "POST",
      `/api/automations/${waiting.id}/run`,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "1 of your tasks are running; wait for one",
    });
    expect(row(chat, waiting.id).nextAt).toBe(due);
    held.main.reply("done");
    await settleRun(chat, held.sessionId);
    await chat.app.shutdown();
  });

  test("Run now takes a waiting fire, so the scheduled start finds nothing due", async () => {
    const { chat } = await stopped();
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);
    const start = fakeStart(chat, () => "user");
    await chat.app.automationScheduler.pass();
    start.restore();

    const run = await startRun(chat, waiting.id);
    expect(row(chat, waiting.id)).toMatchObject({
      lastEventSource: "manual",
      lastEventOutcome: "run",
      nextAt: HOUR,
    });
    chat.app.automationScheduler.wake();
    await chat.app.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(row(chat, waiting.id).lastEventSource).toBe("manual");
    run.main.reply("done");
    await settleRun(chat, run.sessionId);
    await chat.app.shutdown();
  });

  test("after a restart the wait starts once the crashed run is repaired", async () => {
    const { chat } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);
    await chat.app.automationScheduler.pass();
    expect(row(chat, waiting.id).nextAt).toBe(due);

    // the process goes away with the run still marked running
    chat.app.automationScheduler.dispose();
    const send = chat.app.runner.registry.get(held.sessionId)!;
    chat.app.runner.registry.free(send);
    const pending = chat.scripted.next();
    const restarted = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
    });
    expect(restarted.repaired).toBe(1);
    expect(restarted.reconciled).toBe(1);
    const script = await pending;
    expect(restarted.automations.byId(waiting.id)).toMatchObject({
      lastEventOutcome: "run",
      lastEventDueAt: due,
    });
    script.reply("done");
    await settleRun(
      { ...chat, app: restarted },
      restarted.automations.byId(waiting.id)!.lastRunSessionId!,
    );
    await restarted.shutdown();
  });

  test("no start follows a slot freed by shutdown", async () => {
    const { chat, logs } = await stopped();
    const held = await holdSlot(chat);
    const waiting = await createAutomation(chat, { name: "waiting" });
    const due = chat.app.now.value;
    setDue(chat, waiting.id, due);
    chat.app.automationScheduler.start();
    await tick();
    const before = row(chat, waiting.id);

    await chat.app.shutdown();
    for (let i = 0; i < 5; i++) await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(chat.app.sessions.byId(held.sessionId)?.status).not.toBe("running");
    expect(row(chat, waiting.id)).toEqual(before);
    expect(logs.events.some((event) => event.msg === "skip")).toBe(false);
  });
});
