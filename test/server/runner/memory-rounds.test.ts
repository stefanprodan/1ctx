// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../../src/server/providers/index.ts";
import { isMemoryTool } from "../../../src/server/tools/index.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

function call(name: string, args: object | string): ToolCall {
  return {
    id: crypto.randomUUID(),
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function round(script: Script, calls: ToolCall[]): void {
  script.toolRound(calls);
  script.end();
}

function names(script: Script): string[] {
  const tools = script.body.tools as { function: { name: string } }[];
  return tools.map((tool) => tool.function.name);
}

function marks(chat: ChatApp, automationId: string) {
  return chat.app.db
    .query<{ session_id: string; read_activity_at: number }, [string]>(
      `select session_id, read_activity_at from automation_memory_reads
       where automation_id = ? order by session_id`,
    )
    .all(automationId);
}

async function source(chat: ChatApp) {
  const started = await startChat(chat, "Keep the useful facts.");
  started.script.reply("The cluster uses three zones.");
  await settleRun(chat, started.sessionId);
  return chat.app.sessions.byId(started.sessionId)!;
}

describe("memory round settlement", () => {
  test("the phase stops after two failed rounds without another request", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    const handle = active.policy.memoryOffered!.memory!;
    run.main.reply("Done.");
    const first = await waitScript(chat.scripted, 2);
    round(first, [
      call("memory_edit", "{"),
      call("memory_edit", { action: "remove", old_text: "missing" }),
      call("memory_edit", { action: "replace" }),
    ]);
    const second = await waitScript(chat.scripted, 3);
    expect(handle.work.failedRounds).toBe(1);
    expect(handle.stopped).toBe(false);
    round(second, [call("memory_edit", "[]")]);
    await settleRun(chat, run.sessionId);

    expect(handle.work.failedRounds).toBe(2);
    expect(handle.stopped).toBe(true);
    expect(chat.scripted.scripts).toHaveLength(3);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: null,
      rounds: 3,
      toolCalls: 4,
    });
    const rows = chat.app.sessions.messages(run.sessionId);
    expect(
      rows.filter((row) => row.kind === "reply").map((row) => row.round),
    ).toEqual([1, 2, 3]);
    expect(rows.filter((row) => row.status === "streaming")).toEqual([]);
    expect(handle.work.entries).toEqual([]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).revision,
    ).toBe(0);
    await chat.app.shutdown();
  });

  test("main rounds lose all memory tools and stale calls cannot change either copy", async () => {
    const chat = await chatApp();
    const read = await source(chat);
    const automation = await createAutomation(chat, {
      projectMemory: true,
      ownMemory: true,
    });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    const main = active.policy.offered.memory!;
    const own = active.policy.memoryOffered!.memory!;
    const usual = names(run.main).filter((name) => !isMemoryTool(name));
    round(run.main, [
      call("session_read", { id: read.id }),
      call("memory_edit", { action: "remove", old_text: "missing" }),
    ]);
    const second = await waitScript(chat.scripted, 3);
    expect(main.work.failedRounds).toBe(1);
    expect(main.read!.pending.has(read.id)).toBe(true);
    round(second, [call("memory_edit", { action: "replace" })]);
    const stopped = await waitScript(chat.scripted, 4);
    expect(names(stopped)).toEqual(usual);
    expect(main.stopped).toBe(true);
    expect(main.read!.pending.size).toBe(0);
    expect(own.stopped).toBe(false);
    expect(own.work.failedRounds).toBe(0);
    const stale = [
      call("sessions_list", {}),
      call("session_read", { id: read.id }),
      call("memory_edit", { action: "add", text: "Must not be saved." }),
    ];
    round(stopped, stale);
    const answer = await waitScript(chat.scripted, 5);
    expect(names(answer)).toEqual(usual);
    for (const sent of stale) {
      const result = chat.app.sessions
        .messages(run.sessionId)
        .find((row) => row.toolCallId === sent.id)!;
      expect(result.status).toBe("failed");
      expect(result.content).toContain("stopped after 2 failed rounds");
    }
    expect(main.work.entries).toEqual([]);
    expect(main.work.operations).toEqual([]);
    expect(main.read!.pending.size).toBe(0);
    expect(main.read!.marks.size).toBe(0);
    answer.reply("Done without memory.");
    const phase = await waitScript(chat.scripted, 6);
    expect(names(phase)).toEqual(["memory_edit"]);
    round(phase, [
      call("memory_edit", { action: "add", text: "Own note still works." }),
    ]);
    const finish = await waitScript(chat.scripted, 7);
    finish.reply("Recorded.");
    await settleRun(chat, run.sessionId);
    expect(own.work.failedRounds).toBe(0);
    expect(marks(chat, automation.id)).toEqual([]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }).entries,
    ).toEqual([]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual(["Own note still works."]);
    await chat.app.shutdown();
  });
});

describe("pending memory read marks", () => {
  for (const action of [
    "add",
    "replace",
    "remove",
    "none",
    "failed",
    "absent",
  ]) {
    test(`keeps only reads acknowledged by ${action}`, async () => {
      const chat = await chatApp();
      const first = await source(chat);
      const last = await source(chat);
      const target = { projectId: chat.projectId, automationId: null };
      chat.app.memory.save(
        target,
        ["old entry"],
        0,
        chat.memberId,
        chat.app.now.value,
      );
      const automation = await createAutomation(chat, { projectMemory: true });
      const run = await startRun(chat, automation.id);
      const active = chat.app.runner.registry.get(run.sessionId)!;
      const handle = active.policy.offered.memory!;
      const edit =
        action === "absent"
          ? []
          : [
              call("memory_edit", {
                action: action === "failed" ? "remove" : action,
                ...(action === "none"
                  ? {}
                  : {
                      old_text: action === "failed" ? "missing" : "old entry",
                      text: "new entry",
                    }),
              }),
            ];
      round(run.main, [
        call("session_read", { id: first.id }),
        ...edit,
        call("session_read", { id: last.id }),
      ]);
      const answer = await waitScript(chat.scripted, 4);
      const kept = action !== "failed" && action !== "absent";
      expect(handle.read!.marks.has(first.id)).toBe(kept);
      expect(handle.read!.marks.has(last.id)).toBe(false);
      expect(handle.read!.pending.has(last.id)).toBe(true);
      answer.reply("Done.");
      await settleRun(chat, run.sessionId);

      expect(marks(chat, automation.id)).toEqual(
        kept
          ? [{ session_id: first.id, read_activity_at: first.lastActivityAt }]
          : [],
      );
      const next = await startRun(chat, automation.id);
      round(next.main, [call("sessions_list", {})]);
      const nextAnswer = await waitScript(chat.scripted, 6);
      const unread = chat.app.sessions
        .messages(next.sessionId)
        .find((row) => row.toolName === "sessions_list")!.content;
      expect(unread).toContain(`${last.id} |`);
      expect(unread.includes(`${first.id} |`)).toBe(!kept);
      nextAnswer.reply("Done.");
      await settleRun(chat, next.sessionId);
      if (action === "none" || !kept) {
        expect(chat.app.memory.read(target)).toMatchObject({
          entries: ["old entry"],
          revision: 1,
        });
      }
      await chat.app.shutdown();
    });
  }

  test("drops a skipped edit's marks, keeps none's marks and retries without mutating the work", async () => {
    const chat = await chatApp();
    const skippedRead = await source(chat);
    const keptRead = await source(chat);
    const target = { projectId: chat.projectId, automationId: null };
    chat.app.memory.save(
      target,
      ["old entry"],
      0,
      chat.memberId,
      chat.app.now.value,
    );
    const automation = await createAutomation(chat, { projectMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    round(run.main, [
      call("session_read", { id: skippedRead.id }),
      call("memory_edit", {
        action: "replace",
        old_text: "old entry",
        text: "run entry",
      }),
      call("session_read", { id: keptRead.id }),
      call("memory_edit", { action: "none" }),
    ]);
    const answer = await waitScript(chat.scripted, 4);
    const work = active.policy.offered.memory!.work;
    chat.app.memory.save(
      target,
      ["hand entry"],
      1,
      chat.memberId,
      chat.app.now.value,
    );
    const before = JSON.stringify(work);
    for (let attempt = 0; attempt < 2; attempt++) {
      const replayed = chat.app.memory.commit(
        work,
        run.sessionId,
        chat.app.now.value,
      );
      expect(replayed).toMatchObject({
        changed: false,
        skipped: 1,
        skippedOperations: [0],
      });
      expect(JSON.stringify(work)).toBe(before);
    }
    answer.reply("Done.");
    await settleRun(chat, run.sessionId);

    expect(chat.app.memory.read(target)).toMatchObject({
      entries: ["hand entry"],
      revision: 2,
    });
    expect(chat.app.sessions.lastSend(run.sessionId)?.memorySkipped).toBe(1);
    expect(marks(chat, automation.id)).toEqual([
      { session_id: keptRead.id, read_activity_at: keptRead.lastActivityAt },
    ]);
    expect(JSON.stringify(work)).toBe(before);
    await chat.app.shutdown();
  });
});
