// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createAutomation } from "../helpers/automations.ts";
import {
  chatApp,
  NO_TOOLS,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { record, settle, watch, watcher } from "../helpers/socket-fixtures.ts";

describe("socket fixtures", () => {
  test("a plain reply", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "hello");
    watch(chat, conn, sessionId);
    script.content("Hi there.");
    await tick();
    script.finish();
    script.usage();
    script.end();
    await settle(chat);
    record("plain-reply", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    chat.app.socket.dispose();
  });

  test("a memory phase after a run answer", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    watch(chat, conn, detail.session.id);
    const main = await pending;
    main.reply("The task finished.");
    const memory = await waitScript(chat.scripted, 2);
    memory.toolRound([
      {
        id: "m1",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Status","text":"The task finished."}',
      },
    ]);
    memory.end();
    await settle(chat, 10);
    record("memory-phase", detail, conn);
    expect(chat.scripted.scripts).toHaveLength(2);
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      memoryRound: 2,
      rounds: 2,
      toolCalls: 1,
    });
    chat.app.socket.dispose();
  });

  test("a stop during the memory phase", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const conn = await watcher(chat);
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    watch(chat, conn, detail.session.id);
    const main = await pending;
    main.reply("The task finished.");
    const memory = await waitScript(chat.scripted, 2);
    memory.toolRound([
      {
        id: "m1",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Status","text":"Stopped before the note was done."}',
      },
      {
        id: "m2",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    memory.end();
    const open = await waitScript(chat.scripted, 3);
    await chat.member.call("POST", `/api/sessions/${detail.session.id}/stop`);
    await settle(chat, 10);
    record("stop-during-memory", detail, conn);
    expect(open.aborted).toBe(true);
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "done",
      cause: "finish",
      memoryRound: 2,
    });
    chat.app.socket.dispose();
  });

  test("thinking then an answer", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "think");
    watch(chat, conn, sessionId);
    script.reasoning("let me think");
    await tick();
    script.content("The answer.");
    await tick();
    script.finish();
    script.usage();
    script.end();
    await settle(chat);
    record("thinking-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("done");
    chat.app.socket.dispose();
  });

  test("a plain reply on a model without the tools flag", async () => {
    const chat = await chatApp({ model: NO_TOOLS });
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "plain");
    watch(chat, conn, sessionId);
    script.reply("no tools here");
    await settle(chat);
    record("no-tools", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(0);
    chat.app.socket.dispose();
  });

  test("a send that compacts after its answer", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "long chat");
    watch(chat, conn, sessionId);
    script.content("the answer");
    await tick();
    script.finish();
    script.usage({ prompt: 1_040_000, completion: 10 });
    script.end();
    const summary = await waitScript(chat.scripted, 2);
    summary.content("## Goal\n\n- Continue");
    await tick();
    summary.finish();
    summary.usage({ prompt: 41_000, completion: 100 });
    summary.end();
    await settle(chat, 10);
    record("compact-after-answer", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(2);
    chat.app.socket.dispose();
  });

  test("a stop during the summary round", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "stop summary");
    watch(chat, conn, sessionId);
    script.content("the answer");
    script.finish();
    script.usage({ prompt: 1_040_000, completion: 10 });
    script.end();
    const summary = await waitScript(chat.scripted, 2);
    summary.content("partial summary");
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat, 10);
    record("stop-during-summary", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.status).toBe("stopped");
    chat.app.socket.dispose();
  });

  test("a compact send", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "compact this");
    started.script.reply("the answer");
    await settle(chat, 8);
    const conn = await watcher(chat);
    watch(chat, conn, started.sessionId);
    conn.frames = [];
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/compact`,
    );
    expect(response.status).toBe(200);
    const detail = await response.json();
    const summary = await pending;
    summary.content("## Goal\n\n- Compact this");
    await tick();
    summary.finish();
    summary.usage({ prompt: 20, completion: 10 });
    summary.end();
    await settle(chat, 8);
    record("compact-send", detail, conn);
    expect(detail.send.kind).toBe("compact");
    chat.app.socket.dispose();
  });
});
