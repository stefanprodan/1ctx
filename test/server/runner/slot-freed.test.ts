// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// slotFreed wakes the scheduler once a run's send is released for good,
// and only then.

import { describe, expect, test } from "bun:test";
import { FINALIZE_RETRY_MS } from "../../../src/server/runner/index.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

// the wakes since the last reset; the routes wake the scheduler too
async function counted() {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  await tick();
  let wakes = 0;
  chat.app.automationScheduler.wake = () => {
    wakes++;
  };
  return {
    chat,
    wakes: () => wakes,
    reset() {
      wakes = 0;
    },
  };
}

describe("slotFreed", () => {
  test("once for a finished run and once for a stopped one", async () => {
    const { chat, wakes, reset } = await counted();
    const automation = await createAutomation(chat);
    reset();
    const done = await startRun(chat, automation.id);
    done.main.reply("done");
    await settleRun(chat, done.sessionId);
    await tick();
    expect(wakes()).toBe(1);

    const stopped = await startRun(chat, automation.id);
    await chat.member.call("POST", `/api/sessions/${stopped.sessionId}/stop`);
    await settleRun(chat, stopped.sessionId);
    await tick();
    expect(wakes()).toBe(2);
    await chat.app.shutdown();
  });

  test("never for a chat or a compact", async () => {
    const { chat, wakes } = await counted();
    const started = await startChat(chat, "question");
    started.script.reply("answer");
    await settleRun(chat, started.sessionId);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/compact`,
    );
    expect(response.status).toBe(200);
    const summary = await pending;
    summary.reply("## Goal");
    await settleRun(chat, started.sessionId);
    await tick();
    expect(chat.app.runner.registry.size).toBe(0);
    expect(wakes()).toBe(0);
    await chat.app.shutdown();
  });

  test("never for a run ended by shutdown", async () => {
    const { chat, wakes, reset } = await counted();
    const automation = await createAutomation(chat);
    const run = await startRun(chat, automation.id);
    reset();
    await chat.app.shutdown();
    await tick();
    expect(chat.app.sessions.byId(run.sessionId)?.status).not.toBe("running");
    expect(wakes()).toBe(0);
  });

  test("never for an abandoned preparation", async () => {
    const { chat, wakes, reset } = await counted();
    const automation = await createAutomation(chat);
    reset();
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);
    const store = chat.app.automations;
    const record = store.recordEvent.bind(store);
    let failures = 1;
    store.recordEvent = (id, fields) => {
      if (failures-- > 0) throw new Error("event write failed");
      return record(id, fields);
    };
    await chat.app.automationScheduler.fire(automation.id);
    store.recordEvent = record;
    expect(chat.app.runner.registry.size).toBe(0);
    expect(chat.app.sessions.count(chat.projectId)).toBe(0);
    expect(store.byId(automation.id)?.lastEventReason).toBe(
      "event write failed",
    );
    expect(wakes()).toBe(0);
    await chat.app.shutdown();
  });

  test("never for a run whose finalize failed and keeps its lock", async () => {
    const { chat, wakes, reset } = await counted();
    const automation = await createAutomation(chat);
    reset();
    const run = await startRun(chat, automation.id);
    const store = chat.app.sessions;
    const original = store.finishSend.bind(store);
    store.finishSend = () => {
      throw new Error("finalize failed");
    };
    await chat.member.call("POST", `/api/sessions/${run.sessionId}/stop`);
    await tick();
    chat.app.now.value += FINALIZE_RETRY_MS;
    await tick();
    chat.app.now.value += FINALIZE_RETRY_MS;
    await tick();
    await tick();
    store.finishSend = original;
    expect(chat.app.runner.registry.get(run.sessionId)).not.toBeNull();
    expect(wakes()).toBe(0);
  });
});
