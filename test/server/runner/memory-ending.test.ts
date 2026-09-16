// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ending sequence around the memory phase: which causes open it,
// the envelope that opens it, what a shutdown or a restart leaves, and
// what happens when the phase has no room.

import { describe, expect, test } from "bun:test";
import { compose } from "../../../src/server/compose.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { VERSION } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, waitScript } from "../../helpers/chat.ts";
import { frames, watch, watcher } from "../../helpers/socket.ts";

const EDIT = {
  id: "m1",
  name: "memory_edit",
  arguments: '{"action":"set","topic":"Note","text":"Stopped at step two."}',
};
// refused, so the phase asks again and has an open request to end
const REFUSED = {
  id: "m2",
  name: "memory_edit",
  arguments: '{"action":"remove","topic":"Missing"}',
};

describe("the memory phase boundary", () => {
  test("opens the phase in the envelope that closes the answer", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const run = await startRun(chat, automation.id);
    watch(chat, conn, run.sessionId);
    run.main.reply("The check passed.");
    const phase = await waitScript(chat.scripted, 2);
    phase.reply("Nothing to add.");
    await settle(chat, run.sessionId);

    const sessions = frames(conn, "session");
    const opening = sessions.filter((frame) => frame.send?.memoryRound === 2);
    expect(opening).toHaveLength(2);
    const rows = opening[0]!.messages.map((row) => [
      row.round,
      row.slot,
      row.status,
    ]);
    expect(rows).toEqual([
      [1, "answer", "done"],
      [2, "work", "streaming"],
    ]);
    // one terminal envelope: finalizeSend runs once, after the phase
    const ended = sessions.filter((frame) => frame.send?.cause !== null);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.send).toMatchObject({ cause: "finish", status: "done" });
    chat.app.socket.dispose();
    await chat.app.shutdown();
  });

  test("does not open when a shutdown ends the run", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    await chat.app.shutdown();

    expect(chat.scripted.scripts).toHaveLength(1);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "shutdown",
      memoryRound: null,
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([]);
  });

  test("a shutdown inside the phase keeps the cause and its edits", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([EDIT, REFUSED]);
    phase.end();
    const open = await waitScript(chat.scripted, 3);
    await chat.app.shutdown();

    expect(open.aborted).toBe(true);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([{ topic: "Note", text: "Stopped at step two." }]);
  });

  test("a restart ends the run without a phase of its own", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([EDIT, REFUSED]);
    phase.end();
    await waitScript(chat.scripted, 3);
    // the process is gone before the phase ends: a fresh app over the
    // same db repairs what it left running
    chat.app.socket.dispose();
    const fresh = await compose({
      db: chat.app.db,
      secret: (name) => (name === "admin" ? "hunter2-test" : null),
      clock: () => chat.app.now.value,
      fetcher: chat.scripted.fetcher,
      log: () => silent,
      version: VERSION,
      secureCookie: false,
      trustProxy: false,
    });
    const send = fresh.sessions.lastSend(run.sessionId)!;
    expect(send).toMatchObject({ cause: "restart", status: "failed" });
    expect(send.memoryError).not.toBeNull();
    expect(chat.scripted.scripts).toHaveLength(3);
    const replies = fresh.sessions
      .messages(run.sessionId)
      .filter((row) => row.kind === "reply");
    expect(replies.map((row) => [row.round, row.slot])).toEqual([
      [1, "answer"],
      [2, "work"],
      [3, "work"],
    ]);
    expect(
      fresh.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([]);
    fresh.socket.dispose();
  });

  test("records memory_error when the phase does not fit", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    active.policy.contextLength = 1;
    run.main.reply("Done.");
    await settle(chat, run.sessionId);

    // no request went out for the phase
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: "the memory phase did not fit",
    });
    await chat.app.shutdown();
  });

  test("a fire that comes due inside the phase is skipped", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);
    await chat.app.automationScheduler.pass();

    const row = chat.app.automations.byId(automation.id)!;
    expect(row.lastEventOutcome).toBe("skipped");
    expect(row.lastEventReason).toBe("still running");
    expect(chat.scripted.scripts).toHaveLength(2);
    phase.reply("Recorded.");
    await settle(chat, run.sessionId);
    await chat.app.shutdown();
  });
});
