// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import type {
  MemoryCommit,
  MemoryRow,
} from "../../../src/server/memory/index.ts";
import type { ToolCall } from "../../../src/server/providers/index.ts";
import { FINALIZE_RETRY_MS } from "../../../src/server/runner/index.ts";
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
  tick,
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
      call("memory_edit", { action: "remove", topic: "missing" }),
      call("memory_edit", { action: "set" }),
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

  test("stopped project tools refuse stale calls without stopping another automation's own memory", async () => {
    const chat = await chatApp();
    const read = await source(chat);
    const automation = await createAutomation(chat, {
      projectMemory: true,
    });
    const ownAutomation = await createAutomation(chat, {
      name: "own-note",
      ownMemory: true,
    });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    const main = active.policy.offered.memory!;
    expect(active.policy.memoryOffered).toBeNull();
    const usual = names(run.main).filter((name) => !isMemoryTool(name));
    round(run.main, [
      call("session_read", { id: read.id }),
      call("memory_edit", { action: "remove", topic: "missing" }),
    ]);
    const second = await waitScript(chat.scripted, 3);
    expect(main.work.failedRounds).toBe(1);
    expect(main.read!.pending.has(read.id)).toBe(true);
    round(second, [call("memory_edit", { action: "set" })]);
    const stopped = await waitScript(chat.scripted, 4);
    expect(names(stopped)).toEqual(usual);
    expect(main.stopped).toBe(true);
    expect(main.read!.pending.size).toBe(0);
    const stale = [
      call("sessions_list", {}),
      call("session_read", { id: read.id }),
      call("memory_edit", {
        action: "set",
        topic: "Note",
        text: "Must not be saved.",
      }),
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
    await settleRun(chat, run.sessionId);
    const ownRun = await startRun(chat, ownAutomation.id);
    const ownActive = chat.app.runner.registry.get(ownRun.sessionId)!;
    expect(ownActive.policy.offered.memory).toBeNull();
    const own = ownActive.policy.memoryOffered!.memory!;
    expect(own.stopped).toBe(false);
    expect(own.work.failedRounds).toBe(0);
    ownRun.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 7);
    expect(names(phase)).toEqual(["memory_edit"]);
    round(phase, [
      call("memory_edit", {
        action: "set",
        topic: "Note",
        text: "Own note still works.",
      }),
    ]);
    await settleRun(chat, ownRun.sessionId);
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
        automationId: ownAutomation.id,
      }).entries,
    ).toEqual([{ topic: "Note", text: "Own note still works." }]);
    await chat.app.shutdown();
  });
});

describe("pending memory read marks", () => {
  test.serial(
    "a stale-revision write rolls back and retries without resurrecting an undone topic",
    async () => {
      const chat = await chatApp();
      const skippedRead = await source(chat);
      const keptRead = await source(chat);
      const target = { projectId: chat.projectId, automationId: null };
      const store = chat.app.memory;
      const previous = [{ topic: "Other", text: "hand" }];
      store.save(target, previous, 0, chat.memberId, chat.app.now.value);
      store.save(
        target,
        [...previous, { topic: "Note", text: "old" }],
        1,
        chat.memberId,
        chat.app.now.value,
      );
      const automation = await createAutomation(chat, { projectMemory: true });
      const run = await startRun(chat, automation.id);
      const active = chat.app.runner.registry.get(run.sessionId)!;
      round(run.main, [
        call("memory_edit", { action: "remove", topic: "Note" }),
        call("session_read", { id: skippedRead.id }),
        call("memory_edit", { action: "set", topic: "NOTE", text: "run" }),
        call("session_read", { id: keptRead.id }),
        call("memory_edit", { action: "set", topic: "New", text: "keep" }),
      ]);
      const answer = await waitScript(chat.scripted, 4);
      const work = active.policy.offered.memory!.work;
      expect(work.baseRevision).toBe(2);
      expect(
        active.policy.offered.memory!.read!.marks.get(skippedRead.id)
          ?.operation,
      ).toBe(1);
      expect(
        active.policy.offered.memory!.read!.marks.get(keptRead.id)?.operation,
      ).toBe(2);
      const before = structuredClone(work);
      const undone = store.undo(target, 2, chat.memberId, chat.app.now.value);
      expect(undone.entries).toEqual(previous);
      const commits: MemoryCommit[] = [];
      const writes: {
        inTransaction: boolean;
        row: MemoryRow;
        marks: ReturnType<typeof marks>;
      }[] = [];
      const seen: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (
          event.type === "memory.changed" &&
          event.data.projectId === chat.projectId
        ) {
          seen.push(event);
        }
      });
      const commit = store.commit.bind(store);
      const finish = chat.app.sessions.finishSend.bind(chat.app.sessions);
      store.commit = (...args) => {
        const result = commit(...args);
        commits.push(structuredClone(result));
        return result;
      };
      chat.app.sessions.finishSend = (...args) => {
        writes.push({
          inTransaction: chat.app.db.inTransaction,
          row: store.read(target),
          marks: marks(chat, automation.id),
        });
        if (commits.length === 1) {
          throw new Error("rollback after the memory write");
        }
        return finish(...args);
      };
      try {
        answer.reply("Done.");
        await tick();
        expect(commits).toHaveLength(1);
        expect(writes).toEqual([
          {
            inTransaction: true,
            row: commits[0]!.row,
            marks: [
              {
                session_id: keptRead.id,
                read_activity_at: keptRead.lastActivityAt,
              },
            ],
          },
        ]);
        expect(writes[0]!.row).toMatchObject({
          revision: 4,
          previous,
          entries: [...previous, { topic: "New", text: "keep" }],
        });
        expect(store.read(target)).toEqual(undone);
        expect(marks(chat, automation.id)).toEqual([]);
        expect(seen).toEqual([]);
        expect(work).toEqual(before);

        chat.app.now.value += FINALIZE_RETRY_MS;
        await settleRun(chat, run.sessionId);
        expect(commits).toHaveLength(2);
        expect(writes).toHaveLength(2);
        for (const result of commits) {
          expect(result).toMatchObject({
            changed: true,
            skipped: 1,
            skippedOperations: [1],
            row: {
              entries: [...previous, { topic: "New", text: "keep" }],
              previous,
              revision: 4,
              updatedBy: null,
              sessionId: run.sessionId,
            },
          });
        }
        expect(store.read(target)).toEqual(commits[1]!.row);
        expect(writes[1]!.inTransaction).toBe(true);
        expect(seen).toEqual([
          {
            type: "memory.changed",
            data: { ...target, revision: 4 },
          },
        ]);
        expect(marks(chat, automation.id)).toEqual([
          {
            session_id: keptRead.id,
            read_activity_at: keptRead.lastActivityAt,
          },
        ]);
        expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
          status: "done",
          memorySkipped: 1,
        });
        expect(work).toEqual(before);
      } finally {
        store.commit = commit;
        chat.app.sessions.finishSend = finish;
        stop();
        chat.app.now.value += FINALIZE_RETRY_MS;
        await chat.app.shutdown();
      }
    },
  );

  for (const action of [
    "create",
    "set",
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
        [{ topic: "Note", text: "old entry" }],
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
                action:
                  action === "failed"
                    ? "remove"
                    : action === "create"
                      ? "set"
                      : action,
                ...(action === "none"
                  ? {}
                  : {
                      topic:
                        action === "failed"
                          ? "missing"
                          : action === "create"
                            ? "New"
                            : "Note",
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
          entries: [{ topic: "Note", text: "old entry" }],
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
      [{ topic: "Note", text: "old entry" }],
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
        action: "set",
        topic: "Note",
        text: "run entry",
      }),
      call("session_read", { id: keptRead.id }),
      call("memory_edit", { action: "none" }),
    ]);
    const answer = await waitScript(chat.scripted, 4);
    const work = active.policy.offered.memory!.work;
    chat.app.memory.save(
      target,
      [{ topic: "Note", text: "hand entry" }],
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
      entries: [{ topic: "Note", text: "hand entry" }],
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
