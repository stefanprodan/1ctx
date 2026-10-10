// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A task that runs once: the fire that starts its run records the
// event and suspends it in one transaction; a skip, a wait and a plain
// Run now spend nothing; resume arms it again; a cut run of it reruns
// and stays suspended.

import { describe, expect, test } from "bun:test";
import { RunCapacity } from "../../../src/server/runner/index.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import { type TestApp, testApp } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

const HOUR = 3_600_000;

const setDue = (app: TestApp, id: string, at: number) =>
  app.db.query("update automations set next_at = ? where id = ?").run(at, id);

async function stopped() {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  await tick();
  return chat;
}

// suspended by its own fire at that time, nobody named
function expectSpent(row: AutomationSummary, at: number) {
  expect(row).toMatchObject({
    once: true,
    suspendedAt: at,
    onceFiredAt: at,
    suspendedBy: null,
    nextAt: null,
  });
}

// the run's answer, then the run ended
async function finishRun(chat: ChatApp, script: Script, sessionId: string) {
  script.reply("done");
  await settleRun(chat, sessionId);
}

describe("a task that runs once", () => {
  test.serial(
    "its fire records the event, then suspends it, in one transaction",
    async () => {
      const chat = await stopped();
      const automation = await createAutomation(chat, { once: true });
      expect(automation).toMatchObject({ once: true, onceFiredAt: null });
      const store = chat.app.automations;
      const calls: { name: string; open: boolean }[] = [];
      const recordEvent = store.recordEvent.bind(store);
      const spendOnce = store.spendOnce.bind(store);
      store.recordEvent = (id, fields) => {
        calls.push({ name: "recordEvent", open: chat.app.db.inTransaction });
        return recordEvent(id, fields);
      };
      store.spendOnce = (id, now) => {
        calls.push({ name: "spendOnce", open: chat.app.db.inTransaction });
        return spendOnce(id, now);
      };
      const now = chat.app.now.value;
      setDue(chat.app, automation.id, now);
      const pending = chat.scripted.next();
      await chat.app.automationScheduler.pass();
      const script = await pending;
      expect(calls).toEqual([
        { name: "recordEvent", open: true },
        { name: "spendOnce", open: true },
      ]);
      const row = store.byId(automation.id)!;
      expectSpent(row, now);
      expect(row).toMatchObject({
        lastEventAt: now,
        lastEventSource: "schedule",
        lastEventOutcome: "run",
        lastRunStatus: "running",
      });
      await finishRun(chat, script, row.lastRunSessionId!);
      await chat.app.shutdown();
    },
  );

  test.serial(
    "a failed suspend writes no event and starts no run",
    async () => {
      const chat = await stopped();
      const automation = await createAutomation(chat, { once: true });
      const store = chat.app.automations;
      store.spendOnce = () => {
        throw new Error("disk full");
      };
      setDue(chat.app, automation.id, chat.app.now.value);
      await chat.app.automationScheduler.pass();
      await tick();
      const row = store.byId(automation.id)!;
      // the fire's own failure is recorded as a skip, with no run
      expect(row).toMatchObject({
        lastEventOutcome: "skipped",
        lastRunSessionId: null,
        suspendedAt: null,
        onceFiredAt: null,
      });
      expect(chat.app.sessions.runningAutomation(automation.id)).toBe(false);
      await chat.app.shutdown();
    },
  );

  test("no second run starts while a long first one runs past its next time", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    const now = chat.app.now.value;
    setDue(chat.app, automation.id, now);
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    chat.app.now.value += 5 * HOUR;
    await chat.app.automationScheduler.pass();
    await chat.app.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    const row = chat.app.automations.byId(automation.id)!;
    expectSpent(row, now);
    expect(row.lastEventAt).toBe(now);
    await finishRun(chat, script, row.lastRunSessionId!);
    chat.app.now.value += 24 * HOUR;
    await chat.app.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(1);
    await chat.app.shutdown();
  });

  test("a plain Run now spends nothing; one that takes a due fire does", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    const plain = await startRun(chat, automation.id);
    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      lastEventSource: "manual",
      suspendedAt: null,
      onceFiredAt: null,
      nextAt: automation.nextAt,
    });
    await finishRun(chat, plain.main, plain.sessionId);

    // a fire left waiting for a run slot, which Run now takes
    const due = chat.app.now.value;
    setDue(chat.app, automation.id, due);
    chat.app.now.value += 60_000;
    const taken = await startRun(chat, automation.id);
    expectSpent(chat.app.automations.byId(automation.id)!, chat.app.now.value);
    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      lastEventSource: "manual",
      lastEventOutcome: "run",
    });
    await finishRun(chat, taken.main, taken.sessionId);
    await chat.app.shutdown();
  });

  test("a skip and a wait leave it armed until the fire that runs", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    const store = chat.app.automations;

    // a skip moves next_at and keeps it armed
    chat.app.users.setDisabled(chat.memberId, true);
    setDue(chat.app, automation.id, chat.app.now.value);
    await chat.app.automationScheduler.pass();
    const skipped = store.byId(automation.id)!;
    expect(skipped).toMatchObject({
      lastEventOutcome: "skipped",
      suspendedAt: null,
      onceFiredAt: null,
    });
    expect(skipped.nextAt).toBeGreaterThan(chat.app.now.value);
    chat.app.users.setDisabled(chat.memberId, false);

    // a full cap writes nothing
    const due = chat.app.now.value;
    setDue(chat.app, automation.id, due);
    const original = chat.app.runner.startRun;
    chat.app.runner.startRun = () => {
      throw new RunCapacity(
        "process",
        "Too many chats and runs are going. Try again in a moment.",
      );
    };
    await chat.app.automationScheduler.pass();
    expect(store.byId(automation.id)).toMatchObject({
      nextAt: due,
      suspendedAt: null,
      onceFiredAt: null,
    });

    chat.app.runner.startRun = original;
    chat.app.automationScheduler.wake();
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    const row = store.byId(automation.id)!;
    expectSpent(row, chat.app.now.value);
    expect(row.lastEventDueAt).toBe(due);
    await finishRun(chat, script, row.lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("after a long downtime it fires once, at the newest missed time", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    const missed = chat.app.now.value;
    setDue(chat.app, automation.id, missed);
    chat.app.now.value += 10 * HOUR + 60_000;
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    await chat.app.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    const row = chat.app.automations.byId(automation.id)!;
    expectSpent(row, chat.app.now.value);
    // the newest hour passed, the missed ones one skip before it
    expect(row.lastEventDueAt).toBe(
      Math.floor(chat.app.now.value / HOUR) * HOUR,
    );
    expect(row.lastEventDueAt).toBeGreaterThan(missed + 9 * HOUR);
    await finishRun(chat, script, row.lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("resume arms it again; suspend on it changes nothing", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    setDue(chat.app, automation.id, chat.app.now.value);
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    const spent = chat.app.automations.byId(automation.id)!;
    await finishRun(chat, script, spent.lastRunSessionId!);
    const ended = chat.app.automations.byId(automation.id)!;

    const suspend = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    expect(suspend.status).toBe(200);
    expect((await suspend.json()).automation).toEqual(ended);

    chat.app.now.value += HOUR;
    const resume = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/resume`,
    );
    expect(resume.status).toBe(200);
    const armed: AutomationSummary = (await resume.json()).automation;
    expect(armed).toMatchObject({
      once: true,
      suspendedAt: null,
      onceFiredAt: null,
    });
    expect(armed.nextAt).toBeGreaterThan(chat.app.now.value);

    // one more scheduled run, then suspended again
    setDue(chat.app, automation.id, chat.app.now.value);
    const again = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const second = await again;
    const row = chat.app.automations.byId(automation.id)!;
    expectSpent(row, chat.app.now.value);
    await finishRun(chat, second, row.lastRunSessionId!);
    await chat.app.shutdown();
  });

  test("a member's suspend of a task not fired yet is not a run once", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, { once: true });
    const suspend = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/suspend`,
    );
    const row: AutomationSummary = (await suspend.json()).automation;
    expect(row.suspendedBy).toMatchObject({ id: chat.memberId });
    expect(row.onceFiredAt).toBeNull();
    await chat.app.shutdown();
  });
});

describe("a once task cut by a restart", () => {
  const restart = (chat: ChatApp) =>
    testApp({ db: chat.app.db, fetcher: chat.scripted.fetcher });

  test("a restart that meets a due fire spends it", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, {
      once: true,
      rerunOnRestart: true,
    });
    await startRun(chat, automation.id);
    await chat.app.shutdown();
    expect(chat.app.automations.byId(automation.id)!.suspendedAt).toBeNull();
    setDue(chat.app, automation.id, chat.app.now.value);

    const next = await restart(chat);
    await waitScript(chat.scripted, 2);
    const row = next.automations.byId(automation.id)!;
    expect(row.lastEventSource).toBe("restart");
    expectSpent(row, row.lastEventAt!);
    await next.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(2);
    chat.scripted.scripts.at(-1)!.reply("done");
    await settleRun({ ...chat, app: next }, row.lastRunSessionId!);
    await next.shutdown();
  });

  test("its cut run reruns across two restarts and stays suspended", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, {
      once: true,
      rerunOnRestart: true,
    });
    const now = chat.app.now.value;
    setDue(chat.app, automation.id, now);
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    await pending;
    const first = chat.app.automations.byId(automation.id)!;
    expectSpent(first, now);
    await chat.app.shutdown();

    const second = await restart(chat);
    await waitScript(chat.scripted, 2);
    const rerun = second.automations.byId(automation.id)!;
    expect(rerun.lastEventSource).toBe("restart");
    expect(rerun.lastRunSessionId).not.toBe(first.lastRunSessionId);
    expectSpent(rerun, now);
    await second.shutdown();

    const third = await restart(chat);
    await waitScript(chat.scripted, 3);
    const again = third.automations.byId(automation.id)!;
    expect(again.lastEventSource).toBe("restart");
    expect(again.lastRunSessionId).not.toBe(rerun.lastRunSessionId);
    expectSpent(again, now);
    await third.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(3);
    chat.scripted.scripts.at(-1)!.reply("done");
    await settleRun({ ...chat, app: third }, again.lastRunSessionId!);
    // a run that ended is no longer cut: a fourth start reruns nothing
    await third.shutdown();
    const fourth = await restart(chat);
    await fourth.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(3);
    expectSpent(fourth.automations.byId(automation.id)!, now);
    await fourth.shutdown();
  });

  test("a member's suspend still drops the cut run", async () => {
    const chat = await stopped();
    const automation = await createAutomation(chat, {
      once: true,
      rerunOnRestart: true,
    });
    const run = await startRun(chat, automation.id);
    await chat.member.call("POST", `/api/automations/${automation.id}/suspend`);
    await chat.app.shutdown();
    const next = await restart(chat);
    await next.automationScheduler.pass();
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(next.automations.byId(automation.id)!.lastRunSessionId).toBe(
      run.sessionId,
    );
    await next.shutdown();
  });
});

describe("the setting on the wire", () => {
  test("is off by default, set on create, kept by a PATCH that omits it", async () => {
    const chat = await stopped();
    const plain = await createAutomation(chat);
    expect(plain).toMatchObject({ once: false, onceFiredAt: null });
    const patch = (body: Record<string, unknown>) =>
      chat.member.call("PATCH", `/api/automations/${plain.id}`, {
        body: {
          editRevision: chat.app.automations.byId(plain.id)!.editRevision,
          ...body,
        },
      });
    const on = await patch({ once: true });
    expect(on.status).toBe(200);
    const turned: AutomationSummary = (await on.json()).automation;
    expect(turned.once).toBe(true);
    // a change of once is a change: the edit revision moves
    expect(turned.editRevision).toBe(plain.editRevision + 1);
    expect(turned.nextAt).toBe(plain.nextAt);
    const kept = await patch({ name: "renamed" });
    expect((await kept.json()).automation.once).toBe(true);
    const same = await patch({ once: true });
    expect((await same.json()).automation.editRevision).toBe(
      turned.editRevision + 1,
    );
    const bad = await patch({ once: "yes" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "once must be boolean" });
    await chat.app.shutdown();
  });
});
