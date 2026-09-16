// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { memoryRequest } from "../../../src/server/runner/memory-phase.ts";
import { newSend } from "../../../src/server/runner/send.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { frames, watcher } from "../../helpers/socket.ts";

describe("automation memory phase", () => {
  test("opens after an answer, keeps one answer and commits its work", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("The check passed.");

    const edit = await waitScript(chat.scripted, 2);
    expect(
      (edit.body.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["memory_edit"]);
    expect(JSON.stringify(edit.body.messages)).toContain("The check passed.");
    const asked = (script: { body: { messages?: unknown } }) =>
      (script.body.messages as { role: string; content: string }[]).at(-1)!;
    const first = asked(edit);
    expect(first.role).toBe("user");
    expect(first.content).toContain("The run finished.");
    expect(first.content).toContain(
      "This automation's own memory is empty. Use add to write its first entry.",
    );
    expect(first.content).toContain(
      "The project memory in the system prompt is a different note it never edits.",
    );
    expect(first.content).toContain("never the whole note");
    edit.toolRound([
      {
        id: "remember",
        name: "memory_edit",
        arguments: '{"action":"add","text":"Last check passed."}',
      },
    ]);
    edit.end();
    const finish = await waitScript(chat.scripted, 3);
    expect(asked(finish).content).toContain(
      "This automation's own memory holds 1 entry, the version to edit:\n1. Last check passed.",
    );
    finish.reply("Recorded.");

    expect((await settle(chat, run.sessionId))?.status).toBe("done");
    const send = chat.app.sessions.lastSend(run.sessionId)!;
    expect(send).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: null,
      rounds: 3,
      toolCalls: 1,
    });
    const replies = chat.app.sessions
      .messages(run.sessionId)
      .filter((row) => row.kind === "reply");
    expect(replies.map((row) => [row.round, row.slot, row.status])).toEqual([
      [1, "answer", "done"],
      [2, "work", "done"],
      [3, "work", "done"],
    ]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual(["Last check passed."]);
    const usage = chat.app.db
      .query<{ round: number }, [string]>(
        "select round from usage where send_id = ? order by round",
      )
      .all(send.id);
    expect(usage.map((row) => row.round)).toEqual([1, 2, 3]);
    await chat.app.shutdown();
  });

  test("opens after a main failure without changing its cause", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.end();
    const phase = await waitScript(chat.scripted, 2);
    phase.reply("Nothing to add.");

    expect((await settle(chat, run.sessionId))?.status).toBe("failed");
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "failure",
      status: "failed",
      memoryRound: 2,
      memoryError: null,
    });
    const replies = chat.app.sessions
      .messages(run.sessionId)
      .filter((row) => row.kind === "reply");
    expect(replies.map((row) => [row.slot, row.status])).toEqual([
      ["answer", "failed"],
      ["work", "done"],
    ]);
    await chat.app.shutdown();
  });

  test("records a phase failure without changing a finished run", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.end();

    expect((await settle(chat, run.sessionId))?.status).toBe("done");
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: "stream ended early",
    });
    await chat.app.shutdown();
  });

  test("Stop during the phase aborts it and commits completed edits", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const edit = await waitScript(chat.scripted, 2);
    edit.toolRound([
      {
        id: "remember",
        name: "memory_edit",
        arguments: '{"action":"add","text":"Resume from step two."}',
      },
    ]);
    edit.end();
    const open = await waitScript(chat.scripted, 3);
    await chat.member.call("POST", `/api/sessions/${run.sessionId}/stop`);

    expect((await settle(chat, run.sessionId))?.status).toBe("done");
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
    ).toEqual(["Resume from step two."]);
    await chat.app.shutdown();
  });

  test("does not open for a stopped run", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    await chat.member.call("POST", `/api/sessions/${run.sessionId}/stop`);

    expect((await settle(chat, run.sessionId))?.status).toBe("stopped");
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "stop",
      memoryRound: null,
    });
    await chat.app.shutdown();
  });
});

describe("memory task run", () => {
  test("reads chats, commits both notes and carries them into later sends", async () => {
    const chat = await chatApp();
    const source = await startChat(chat, "The cluster is in eu-west-1.");
    source.script.reply("Recorded in the chat.");
    await settle(chat, source.sessionId);
    const automation = await createAutomation(chat, {
      name: "memory-task",
      projectMemory: true,
      ownMemory: true,
    });

    const first = await startRun(chat, automation.id);
    first.main.toolRound([
      {
        id: "list",
        name: "sessions_list",
        arguments: "{}",
      },
    ]);
    first.main.end();
    const read = await waitScript(chat.scripted, 3);
    read.toolRound([
      {
        id: "read",
        name: "session_read",
        arguments: JSON.stringify({ id: source.sessionId }),
      },
    ]);
    read.end();
    const projectEdit = await waitScript(chat.scripted, 4);
    projectEdit.toolRound([
      {
        id: "project-memory",
        name: "memory_edit",
        arguments: '{"action":"add","text":"The cluster is in eu-west-1."}',
      },
    ]);
    projectEdit.end();
    const mainFinish = await waitScript(chat.scripted, 5);
    mainFinish.reply("Project memory prepared.");
    const ownEdit = await waitScript(chat.scripted, 6);
    ownEdit.toolRound([
      {
        id: "own-memory",
        name: "memory_edit",
        arguments: '{"action":"add","text":"The first memory pass completed."}',
      },
    ]);
    ownEdit.end();
    const phaseFinish = await waitScript(chat.scripted, 7);
    phaseFinish.reply("Recorded.");
    await settle(chat, first.sessionId);

    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }).entries,
    ).toEqual(["The cluster is in eu-west-1."]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual(["The first memory pass completed."]);
    expect(
      chat.app.db
        .query<{ count: number }, [string, string]>(
          `select count(*) as count from automation_memory_reads
           where automation_id = ? and session_id = ?`,
        )
        .get(automation.id, source.sessionId)!.count,
    ).toBe(1);

    const second = await startRun(chat, automation.id);
    const secondPrompt = JSON.stringify(second.main.body.messages);
    expect(secondPrompt).toContain("The cluster is in eu-west-1.");
    expect(secondPrompt).toContain("The first memory pass completed.");
    second.main.toolRound([
      {
        id: "list-again",
        name: "sessions_list",
        arguments: "{}",
      },
    ]);
    second.main.end();
    const secondFinish = await waitScript(chat.scripted, 9);
    const listResult = chat.app.sessions
      .messages(second.sessionId)
      .find((row) => row.kind === "tool" && row.toolName === "sessions_list");
    expect(listResult?.content).toBe("Every chat is read.");
    secondFinish.reply("Nothing new.");
    const secondPhase = await waitScript(chat.scripted, 10);
    secondPhase.reply("Nothing to change.");
    await settle(chat, second.sessionId);

    const later = await startChat(chat, "Where is the cluster?");
    expect(JSON.stringify(later.script.body.messages)).toContain(
      "The cluster is in eu-west-1.",
    );
    later.script.reply("It is in eu-west-1.");
    await settle(chat, later.sessionId);
    await chat.app.shutdown();
  });
});

// a memory task run that reads one chat and edits the project note,
// left open on its third round for the caller to end
async function readAndEdit(
  chat: ChatApp,
  automationId: string,
  sourceId: string,
) {
  const run = await startRun(chat, automationId);
  const first = chat.scripted.scripts.length;
  run.main.toolRound([
    {
      id: "read",
      name: "session_read",
      arguments: JSON.stringify({ id: sourceId }),
    },
  ]);
  run.main.end();
  const edit = await waitScript(chat.scripted, first + 1);
  edit.toolRound([
    {
      id: "edit",
      name: "memory_edit",
      arguments: '{"action":"add","text":"A pending fact."}',
    },
  ]);
  edit.end();
  await waitScript(chat.scripted, first + 2);
  return run;
}

function notes(chat: ChatApp, automationId: string | null) {
  return chat.app.memory.read({ projectId: chat.projectId, automationId });
}

function marks(chat: ChatApp, automationId: string): number {
  return chat.app.db
    .query<{ count: number }, [string]>(
      `select count(*) as count from automation_memory_reads
       where automation_id = ?`,
    )
    .get(automationId)!.count;
}

describe("project memory working copy", () => {
  test("writes nothing and sends no frame before the run ends", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const automation = await createAutomation(chat, {
      name: "note-task",
      projectMemory: true,
      ownMemory: true,
    });
    const run = await startRun(chat, automation.id);
    run.main.toolRound([
      {
        id: "edit",
        name: "memory_edit",
        arguments: '{"action":"add","text":"The cluster is in eu-west-1."}',
      },
    ]);
    run.main.end();
    await waitScript(chat.scripted, 2);
    expect(notes(chat, null)).toMatchObject({ entries: [], revision: 0 });
    expect(frames(conn, "memory")).toEqual([]);

    // a chat that starts between two edits reads the note as it stands
    const between = await startChat(chat, "where is the cluster?");
    expect(JSON.stringify(between.script.body.messages)).not.toContain(
      "eu-west-1",
    );
    between.script.reply("I do not know.");
    await settle(chat, between.sessionId);

    const mainFinish = await waitScript(chat.scripted, 2);
    mainFinish.reply("Project memory prepared.");
    const phase = await waitScript(chat.scripted, 4);
    phase.toolRound([
      {
        id: "own",
        name: "memory_edit",
        arguments: '{"action":"add","text":"The first pass is done."}',
      },
    ]);
    phase.end();
    const phaseFinish = await waitScript(chat.scripted, 5);
    phaseFinish.reply("Recorded.");
    await settle(chat, run.sessionId);

    expect(notes(chat, null)).toMatchObject({
      entries: ["The cluster is in eu-west-1."],
      revision: 1,
    });
    expect(notes(chat, automation.id)).toMatchObject({
      entries: ["The first pass is done."],
      revision: 1,
    });
    // one frame per note, each carrying the revision it committed
    expect(frames(conn, "memory")).toEqual([
      {
        type: "memory",
        projectId: chat.projectId,
        automationId: null,
        revision: 1,
      },
      {
        type: "memory",
        projectId: chat.projectId,
        automationId: automation.id,
        revision: 1,
      },
    ]);
    chat.app.socket.dispose();
    await chat.app.shutdown();
  });

  test("drops edits and read marks when a run is stopped", async () => {
    const chat = await chatApp();
    const source = await startChat(chat, "Keep this fact.");
    source.script.reply("The fact is in this chat.");
    await settle(chat, source.sessionId);
    const automation = await createAutomation(chat, {
      name: "stopped-memory",
      projectMemory: true,
    });
    const run = await readAndEdit(chat, automation.id, source.sessionId);
    await chat.member.call("POST", `/api/sessions/${run.sessionId}/stop`);
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)?.cause).toBe("stop");
    expect(notes(chat, null).entries).toEqual([]);
    expect(marks(chat, automation.id)).toBe(0);
    await chat.app.shutdown();
  });

  test("drops edits and read marks when the run deadline cuts it", async () => {
    const chat = await chatApp();
    const source = await startChat(chat, "Keep this fact.");
    source.script.reply("The fact is in this chat.");
    await settle(chat, source.sessionId);
    const automation = await createAutomation(chat, {
      name: "cut-memory",
      projectMemory: true,
    });
    const run = await readAndEdit(chat, automation.id, source.sessionId);
    chat.app.now.value += DEFAULT_LIMITS.runDeadlineMs;
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "deadline",
      status: "stopped",
    });
    expect(notes(chat, null).entries).toEqual([]);
    expect(marks(chat, automation.id)).toBe(0);
    await chat.app.shutdown();
  });

  test("drops edits and read marks when a memory task fails", async () => {
    const chat = await chatApp();
    const source = await startChat(chat, "Keep this fact.");
    source.script.reply("The fact is in this chat.");
    await settle(chat, source.sessionId);
    const automation = await createAutomation(chat, {
      name: "failing-memory",
      projectMemory: true,
    });
    const run = await startRun(chat, automation.id);
    run.main.toolRound([
      { id: "list", name: "sessions_list", arguments: "{}" },
    ]);
    run.main.end();
    const read = await waitScript(chat.scripted, 3);
    read.toolRound([
      {
        id: "read",
        name: "session_read",
        arguments: JSON.stringify({ id: source.sessionId }),
      },
    ]);
    read.end();
    const edit = await waitScript(chat.scripted, 4);
    edit.toolRound([
      {
        id: "edit",
        name: "memory_edit",
        arguments: '{"action":"add","text":"A pending fact."}',
      },
    ]);
    edit.end();
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }).entries,
    ).toEqual([]);
    const fail = await waitScript(chat.scripted, 5);
    fail.end();
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)?.cause).toBe("failure");
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }).entries,
    ).toEqual([]);
    const marks = chat.app.db
      .query<{ count: number }, [string]>(
        `select count(*) as count from automation_memory_reads
         where automation_id = ?`,
      )
      .get(automation.id)!;
    expect(marks.count).toBe(0);
    await chat.app.shutdown();
  });

  test("replays over a hand edit and records an edit that no longer applies", async () => {
    const chat = await chatApp();
    const saved = await chat.member.call(
      "PUT",
      `/api/projects/${chat.projectId}/memory`,
      { body: { entries: ["old entry"], revision: 0 } },
    );
    expect(saved.status).toBe(200);
    const automation = await createAutomation(chat, {
      name: "replay-memory",
      projectMemory: true,
    });
    const run = await startRun(chat, automation.id);
    run.main.toolRound([
      {
        id: "edit",
        name: "memory_edit",
        arguments:
          '{"action":"replace","old_text":"old entry","text":"run entry"}',
      },
    ]);
    run.main.end();
    const finish = await waitScript(chat.scripted, 2);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }),
    ).toMatchObject({ entries: ["old entry"], revision: 1 });
    const hand = await chat.member.call(
      "PUT",
      `/api/projects/${chat.projectId}/memory`,
      { body: { entries: ["hand entry"], revision: 1 } },
    );
    expect(hand.status).toBe(200);
    finish.reply("Finished.");
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      memorySkipped: 1,
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: null,
      }),
    ).toMatchObject({ entries: ["hand entry"], revision: 2 });
    await chat.app.shutdown();
  });
});

describe("memory phase room", () => {
  test("drops old rounds, keeps the last and skips counting a null window", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    const probe = newSend({
      id: "probe-send",
      sessionId: "probe-session",
      projectId: chat.projectId,
      kind: "run",
      policy: {
        ...active.policy,
        contextLength: null,
        limits: { ...active.policy.limits, contextReserve: 0 },
      },
      firstMessageId: "probe-user",
      replyId: "probe-reply",
      now: 0,
    });
    probe.cause = "finish";
    const old = `old round ${"x".repeat(800)}`;
    const latest = `latest round ${"y".repeat(80)}`;
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "task" },
      { role: "assistant" as const, content: old },
      { role: "assistant" as const, content: latest },
    ];
    const offered = probe.policy.memoryOffered!;
    expect(JSON.stringify(memoryRequest(probe, messages, offered))).toContain(
      old,
    );

    let trimmed: ReturnType<typeof memoryRequest> = null;
    for (let window = 1; window <= 2000; window++) {
      probe.policy.contextLength = window;
      const candidate = memoryRequest(probe, messages, offered);
      if (
        candidate !== null &&
        !JSON.stringify(candidate.messages).includes(old)
      ) {
        trimmed = candidate;
        break;
      }
    }
    expect(JSON.stringify(trimmed?.messages)).toContain(latest);
    expect(JSON.stringify(trimmed?.messages)).not.toContain(old);
    probe.policy.contextLength = 1;
    expect(memoryRequest(probe, messages, offered)).toBeNull();

    await chat.member.call("POST", `/api/sessions/${run.sessionId}/stop`);
    await settle(chat, run.sessionId);
    await chat.app.shutdown();
  });
});

describe("memory phase bounds", () => {
  test("opens after the run deadline and keeps the deadline outcome", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    chat.app.now.value += DEFAULT_LIMITS.runDeadlineMs;
    const phase = await waitScript(chat.scripted, 2);
    expect(run.main.aborted).toBe(true);
    phase.reply("Recorded the cutoff.");
    await settle(chat, run.sessionId);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "deadline",
      status: "stopped",
      memoryRound: 2,
    });
    await chat.app.shutdown();
  });

  test("ends calls at the phase round cap without running them", async () => {
    const chat = await chatApp();
    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: {
        values: { ...DEFAULT_LIMITS, memoryPhaseRounds: 1 },
      },
    });
    expect(changed.status).toBe(200);
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([
      {
        id: "over-cap",
        name: "memory_edit",
        arguments: '{"action":"add","text":"not applied"}',
      },
    ]);
    phase.end();
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      memoryRound: 2,
      rounds: 2,
      toolCalls: 0,
    });
    const tool = chat.app.sessions
      .messages(run.sessionId)
      .find((row) => row.kind === "tool");
    expect(tool).toMatchObject({
      status: "stopped",
      content: "not run: the memory phase was on its last round",
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([]);
    await chat.app.shutdown();
  });

  test("runs its calls after the send spent its own call budget", async () => {
    const chat = await chatApp();
    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: { values: { ...DEFAULT_LIMITS, callsPerSend: 1 } },
    });
    expect(changed.status).toBe(200);
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const clock = {
      id: "t1",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    };
    run.main.toolRound([clock]);
    run.main.end();
    const spent = await waitScript(chat.scripted, 2);
    spent.toolRound([{ ...clock, id: "t2" }]);
    spent.end();
    const answer = await waitScript(chat.scripted, 3);
    answer.reply("Done.");
    const phase = await waitScript(chat.scripted, 4);
    phase.toolRound([
      {
        id: "m1",
        name: "memory_edit",
        arguments: '{"action":"add","text":"Recorded all the same."}',
      },
    ]);
    phase.end();
    const phaseFinish = await waitScript(chat.scripted, 5);
    phaseFinish.reply("Recorded.");
    await settle(chat, run.sessionId);

    const rows = chat.app.sessions
      .messages(run.sessionId)
      .filter((row) => row.kind === "tool");
    expect(rows.map((row) => [row.toolName, row.status])).toEqual([
      ["datetime", "done"],
      ["datetime", "stopped"],
      ["memory_edit", "done"],
    ]);
    expect(rows[1]?.content).toBe("not run: the tool budget was spent");
    expect(rows[2]?.content).toContain("Saved for the end of the run");
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual(["Recorded all the same."]);
    await chat.app.shutdown();
  });

  test("the phase deadline stops its open reply", async () => {
    const chat = await chatApp();
    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: {
        values: { ...DEFAULT_LIMITS, memoryPhaseMs: 10_000 },
      },
    });
    expect(changed.status).toBe(200);
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    chat.app.now.value += 10_000;
    await settle(chat, run.sessionId);

    expect(phase.aborted).toBe(true);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryError: null,
    });
    const phaseReply = chat.app.sessions
      .messages(run.sessionId)
      .find((row) => row.kind === "reply" && row.round === 2);
    expect(phaseReply).toMatchObject({ slot: "work", status: "stopped" });
    await chat.app.shutdown();
  });
});
