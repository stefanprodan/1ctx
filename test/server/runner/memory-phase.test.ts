// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  MEMORY_EXCERPT_CHARS,
  memorySystem,
} from "../../../src/server/runner/memory-packet.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { frames, watcher } from "../../helpers/socket.ts";

describe("automation memory phase", () => {
  test("snapshots guidance and uses it only in the own-note phase instruction", async () => {
    const chat = await chatApp();
    const guidance = "Sources: keep failed hosts and how they failed.";
    const automation = await createAutomation(chat, {
      ownMemory: true,
      memoryGuidance: guidance,
    });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    expect(active.policy.automation?.memoryGuidance).toBe(guidance);
    expect(JSON.stringify(run.main.body.messages)).not.toContain(guidance);
    const edited = await chat.member.call(
      "PATCH",
      `/api/automations/${automation.id}`,
      {
        body: {
          instructions: "A different task for later runs.",
          memoryGuidance: "New guidance for later runs.",
        },
      },
    );
    expect(edited.status).toBe(200);
    expect(active.policy.automation?.memoryGuidance).toBe(guidance);
    run.main.reply("The check passed.");
    const phase = await waitScript(chat.scripted, 2);
    const messages = phase.body.messages as { role: string; content: string }[];
    const instruction = messages.at(-1)!;
    expect(instruction).toMatchObject({ role: "user" });
    expect(instruction.content).toContain(`What to remember:\n${guidance}`);
    expect(instruction.content).toContain(
      "The run was asked:\n<task>\ncheck the system\n</task>",
    );
    expect(instruction.content).toContain(
      "A topic names what an entry is about, never one fact.",
    );
    expect(JSON.stringify(messages.slice(0, -1))).not.toContain(guidance);
    expect(JSON.stringify(messages)).not.toContain(
      "New guidance for later runs.",
    );
    expect(JSON.stringify(messages)).not.toContain(
      "A different task for later runs.",
    );
    phase.reply("No change.");
    await settle(chat, run.sessionId);
    const next = await startRun(chat, automation.id);
    expect(
      chat.app.runner.registry.get(next.sessionId)?.policy.automation
        ?.memoryGuidance,
    ).toBe("New guidance for later runs.");
    expect(JSON.stringify(next.main.body.messages)).not.toContain(
      "New guidance for later runs.",
    );
    await chat.member.call("POST", `/api/sessions/${next.sessionId}/stop`);
    await settle(chat, next.sessionId);
    await chat.app.shutdown();
  });

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
      (script.body.messages as { role: string; content: string }[])[1]!;
    const first = asked(edit);
    expect(first.role).toBe("user");
    expect(first.content).toContain("The run finished.");
    expect(first.content).toContain(
      "This automation's own memory is empty. Use set to write its first entry.",
    );
    expect(first.content).not.toContain("system prompt");
    expect(first.content).toContain(
      "A topic names what an entry is about, never one fact.",
    );
    // a refused edit keeps the phase asking; a clean round would end it
    edit.toolRound([
      {
        id: "remember",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Note","text":"Last check passed."}',
      },
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    edit.end();
    const finish = await waitScript(chat.scripted, 3);
    expect(asked(finish).content).toContain(
      "This automation's own memory holds 1 entry, the version to edit:\n1. Note [18/500]\nLast check passed.",
    );
    expect(asked(finish).content).toContain("26 of 2,200 characters.");
    expect(
      (finish.body.messages as { role: string }[]).map(
        (message) => message.role,
      ),
    ).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect((finish.body.messages as unknown[]).slice(2)).toMatchObject([
      {
        role: "assistant",
        tool_calls: [{ id: "remember" }, { id: "missing" }],
      },
      { role: "tool", tool_call_id: "remember" },
      { role: "tool", tool_call_id: "missing" },
    ]);
    expect(asked(finish).content).not.toContain('{"action":"set"');
    finish.reply("Recorded.");

    expect((await settle(chat, run.sessionId))?.status).toBe("done");
    const send = chat.app.sessions.lastSend(run.sessionId)!;
    expect(send).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: null,
      rounds: 3,
      toolCalls: 2,
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
    ).toEqual([{ topic: "Note", text: "Last check passed." }]);
    const usage = chat.app.db
      .query<{ round: number }, [string]>(
        "select round from usage where send_id = ? order by round",
      )
      .all(send.id);
    expect(usage.map((row) => row.round)).toEqual([1, 2, 3]);
    await chat.app.shutdown();
  });

  test("ends after a round whose edits all succeed, without asking again", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("The check passed.");
    const edit = await waitScript(chat.scripted, 2);
    edit.toolRound([
      {
        id: "remember",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Note","text":"Last check passed."}',
      },
    ]);
    edit.end();
    expect((await settle(chat, run.sessionId))?.status).toBe("done");
    expect(chat.scripted.scripts).toHaveLength(2);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      memoryRound: 2,
      memoryError: null,
      rounds: 2,
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([{ topic: "Note", text: "Last check passed." }]);
    await chat.app.shutdown();
  });

  test("opens after a main failure without changing its cause", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.end();
    const phase = await waitScript(chat.scripted, 2);
    expect(
      (phase.body.messages as { content: string }[])[1]!.content,
    ).toContain("The run failed: stream ended early");
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
        arguments:
          '{"action":"set","topic":"Note","text":"Resume from step two."}',
      },
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
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
    ).toEqual([{ topic: "Note", text: "Resume from step two." }]);
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

describe("own memory and the project note", () => {
  test("a run commits its own note and every send reads the project note live", async () => {
    const chat = await chatApp();
    const saved = await chat.member.call(
      "PUT",
      `/api/projects/${chat.projectId}/memory`,
      {
        body: {
          entries: [{ topic: "Note", text: "The cluster is in eu-west-1." }],
          revision: 0,
        },
      },
    );
    expect(saved.status).toBe(200);
    const automation = await createAutomation(chat, {
      name: "own-note",
      ownMemory: true,
    });
    const first = await startRun(chat, automation.id);
    expect(JSON.stringify(first.main.body.messages)).toContain(
      "The cluster is in eu-west-1.",
    );
    first.main.reply("The first pass completed.");
    const edit = await waitScript(chat.scripted, 2);
    edit.toolRound([
      {
        id: "own-memory",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Note","text":"The first pass completed."}',
      },
    ]);
    edit.end();
    await settle(chat, first.sessionId);
    expect(notes(chat, null).entries).toEqual([
      { topic: "Note", text: "The cluster is in eu-west-1." },
    ]);
    expect(notes(chat, automation.id).entries).toEqual([
      { topic: "Note", text: "The first pass completed." },
    ]);

    const moved = await chat.member.call(
      "PUT",
      `/api/projects/${chat.projectId}/memory`,
      {
        body: {
          entries: [{ topic: "Note", text: "The cluster moved to us-east-1." }],
          revision: 1,
        },
      },
    );
    expect(moved.status).toBe(200);
    const second = await startRun(chat, automation.id);
    const prompt = JSON.stringify(second.main.body.messages);
    expect(prompt).toContain("The cluster moved to us-east-1.");
    expect(prompt).toContain("The first pass completed.");
    second.main.reply("Nothing new.");
    const phase = await waitScript(chat.scripted, 4);
    phase.reply("Nothing to change.");
    await settle(chat, second.sessionId);

    const later = await startChat(chat, "Where is the cluster?");
    const chatPrompt = JSON.stringify(later.script.body.messages);
    expect(chatPrompt).toContain("The cluster moved to us-east-1.");
    expect(chatPrompt).not.toContain("The first pass completed.");
    later.script.reply("It is in us-east-1.");
    await settle(chat, later.sessionId);
    await chat.app.shutdown();
  });

  test("writes the own note and sends its frame only when the run ends", async () => {
    const chat = await chatApp();
    const conn = await watcher(chat);
    const automation = await createAutomation(chat, {
      name: "own-note",
      ownMemory: true,
    });
    const run = await startRun(chat, automation.id);
    run.main.reply("The first pass is done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([
      {
        id: "own",
        name: "memory_edit",
        arguments:
          '{"action":"set","topic":"Note","text":"The first pass is done."}',
      },
      // refused, so the phase asks again and its edit waits for the end
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    phase.end();
    const finish = await waitScript(chat.scripted, 3);
    expect(notes(chat, automation.id)).toMatchObject({
      entries: [],
      revision: 0,
    });
    expect(frames(conn, "memory")).toEqual([]);
    finish.reply("Recorded.");
    await settle(chat, run.sessionId);

    expect(notes(chat, automation.id)).toMatchObject({
      entries: [{ topic: "Note", text: "The first pass is done." }],
      revision: 1,
    });
    expect(frames(conn, "memory")).toEqual([
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

  test("replays over a hand edit and records an edit that no longer applies", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, {
      name: "replay-memory",
      ownMemory: true,
    });
    const target = { projectId: chat.projectId, automationId: automation.id };
    chat.app.memory.save(
      target,
      [{ topic: "Note", text: "old entry" }],
      0,
      chat.memberId,
      chat.app.now.value,
    );
    const run = await startRun(chat, automation.id);
    run.main.reply("Done.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([
      {
        id: "edit",
        name: "memory_edit",
        arguments: '{"action":"set","topic":"Note","text":"run entry"}',
      },
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    phase.end();
    const finish = await waitScript(chat.scripted, 3);
    chat.app.memory.save(
      target,
      [{ topic: "Note", text: "hand entry" }],
      1,
      chat.memberId,
      chat.app.now.value,
    );
    finish.reply("Finished.");
    await settle(chat, run.sessionId);

    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      memorySkipped: 1,
    });
    expect(notes(chat, automation.id)).toMatchObject({
      entries: [{ topic: "Note", text: "hand entry" }],
      revision: 2,
    });
    await chat.app.shutdown();
  });
});

function notes(chat: ChatApp, automationId: string | null) {
  return chat.app.memory.read({ projectId: chat.projectId, automationId });
}

describe("memory phase room", () => {
  test("counts tool schemas before sending and records a note that cannot fit", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const saved = await chat.member.call(
      "PUT",
      `/api/automations/${automation.id}/memory`,
      {
        body: {
          entries: [{ topic: "Sources", text: "Try the public feed next." }],
          revision: 0,
        },
      },
    );
    expect(saved.status).toBe(200);
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    active.policy.contextLength = null;
    run.main.reply("");
    const phase = await waitScript(chat.scripted, 2);
    const messagesOnly = tokens(
      JSON.stringify({
        messages: phase.body.messages,
        tools: [],
      }),
    );
    expect(
      tokens(
        JSON.stringify({
          messages: phase.body.messages,
          tools: phase.body.tools,
        }),
      ),
    ).toBeGreaterThan(messagesOnly);
    phase.reply("No change.");
    await settle(chat, run.sessionId);

    const next = await startRun(chat, automation.id);
    const nextActive = chat.app.runner.registry.get(next.sessionId)!;
    nextActive.policy.contextLength = messagesOnly;
    nextActive.policy.limits.contextReserve = 0;
    next.main.reply("");
    await settle(chat, next.sessionId);
    expect(chat.scripted.scripts).toHaveLength(3);
    expect(chat.app.sessions.lastSend(next.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: "the memory phase did not fit",
    });
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).entries,
    ).toEqual([{ topic: "Sources", text: "Try the public feed next." }]);
    await chat.app.shutdown();
  });

  test("a null window lets a provider refusal become memory_error", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    active.policy.contextLength = null;
    chat.scripted.refuse(400, "context window exceeded");
    run.main.reply("Done.");
    await settle(chat, run.sessionId);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryError: expect.stringContaining("context window exceeded"),
    });
    await chat.app.shutdown();
  });

  test("recounts phase calls before a second request instead of dropping them", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    active.policy.contextLength = null;
    run.main.reply("");
    const phase = await waitScript(chat.scripted, 2);
    active.policy.contextLength = tokens(
      JSON.stringify({
        messages: phase.body.messages,
        tools: phase.body.tools,
      }),
    );
    active.policy.limits.contextReserve = 0;
    // refused, so the phase needs a second request
    phase.toolRound([
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    phase.end();
    await settle(chat, run.sessionId);
    expect(chat.scripted.scripts).toHaveLength(2);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      toolCalls: 1,
      memoryError: "the memory phase did not fit",
    });
    await chat.app.shutdown();
  });
});

describe("memory phase input", () => {
  test("sends only a packet and phase calls, with full-row receipts under its own prompt", async () => {
    const page = `Consent required. ${"Page body. ".repeat(2500)}`;
    const chat = await chatApp({
      fetcher: (async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://consent.example/report") {
          return new Response(page, {
            headers: { "content-type": "text/plain" },
          });
        }
        if (url === "https://blocked.example/report") {
          return new Response("access denied", { status: 403 });
        }
        throw new Error(`unexpected test fetch: ${url}`);
      }) as typeof fetch,
    });
    chat.app.automationScheduler.stop();
    const updated = await chat.admin.call(
      "PATCH",
      `/api/agents/${chat.agentId}`,
      {
        body: {
          name: "coder",
          providerId: chat.providerId,
          model: FLASH,
          thinking: "on",
          effort: "high",
          servers: [],
          mcpMode: "auto",
        },
      },
    );
    expect(updated.status).toBe(200);
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.content("Main work that the packet does not need.");
    run.main.reasoning("Main reasoning that the packet does not need.");
    run.main.toolRound([
      {
        id: "bad",
        name: "webfetch",
        arguments: '{"url":"https://blocked.example/report"}',
      },
      {
        id: "ok",
        name: "webfetch",
        arguments: '{"url":"https://consent.example/report"}',
      },
    ]);
    run.main.end();
    const answer = await waitScript(chat.scripted, 2);
    const mainTools = chat.app.sessions
      .messages(run.sessionId)
      .filter((row) => row.kind === "tool");
    expect(mainTools.map((row) => row.status)).toEqual(["failed", "done"]);
    const success = mainTools[1]!;
    expect(success.content.length).toBeGreaterThan(MEMORY_EXCERPT_CHARS);
    chat.app.now.value += 2000;
    answer.reply("Both sources were blocked.");
    const phase = await waitScript(chat.scripted, 3);
    const messages = phase.body.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    // never the run's prompt, which tells the model to do the task
    expect(messages[0]).toEqual({
      role: "system",
      content: memorySystem(automation.name),
    });
    expect(messages[0]!.content).not.toBe(
      (run.main.body.messages as { role: string; content: string }[])[0]!
        .content,
    );
    expect(messages[1]!.content).toContain(`failed: ${mainTools[0]!.error}`);
    expect(messages[1]!.content).toContain(
      `done (${new TextEncoder().encode(success.content).length} bytes)`,
    );
    expect(messages[1]!.content).toContain(
      `Excerpt: ${success.content.slice(0, MEMORY_EXCERPT_CHARS)}`,
    );
    expect(messages[1]!.content).not.toContain(
      success.content.slice(0, MEMORY_EXCERPT_CHARS + 1),
    );
    expect(messages[1]!.content).not.toContain("Main work");
    expect(JSON.stringify(messages)).not.toContain("Main reasoning");
    expect(phase.body.enable_thinking).toBe(true);
    expect(phase.body.reasoning_effort).toBe("high");
    phase.toolRound([
      {
        id: "missing",
        name: "memory_edit",
        arguments: '{"action":"remove","topic":"Missing"}',
      },
    ]);
    phase.end();
    const finish = await waitScript(chat.scripted, 4);
    const continued = finish.body.messages as {
      role: string;
      content: string;
    }[];
    expect(continued.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(continued.slice(0, 2)).toEqual(messages);
    expect(continued.slice(2)).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "missing" }] },
      { role: "tool", tool_call_id: "missing" },
    ]);
    expect(continued[1]!.content).not.toContain('{"action":"remove"');
    finish.reply("No change.");
    await settle(chat, run.sessionId);
    expect(
      chat.app.sessions
        .messages(run.sessionId)
        .filter((row) => row.kind === "user"),
    ).toHaveLength(1);
    await chat.app.shutdown();
  });

  test("an answerless run carries the report beside its unrun call", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.content("The report is complete, but its call could not run.");
    run.main.toolCall({
      id: "unrun",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    run.main.finish("length");
    run.main.usage();
    run.main.end();
    const phase = await waitScript(chat.scripted, 2);
    const messages = phase.body.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toContain(
      "Last work text:\n<answer>\nThe report is complete, but its call could not run.\n</answer>",
    );
    expect(messages[1]!.content).toContain("failed: not run:");
    expect(messages[1]!.content).not.toContain("Run's answer:");
    phase.reply("No change.");
    await settle(chat, run.sessionId);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      memoryError: null,
    });
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
    expect(
      (phase.body.messages as { content: string }[])[1]!.content,
    ).toContain("The run was cut by its deadline.");
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
        arguments: '{"action":"set","topic":"Note","text":"not applied"}',
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
        arguments:
          '{"action":"set","topic":"Note","text":"Recorded all the same."}',
      },
    ]);
    phase.end();
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
    ).toEqual([{ topic: "Note", text: "Recorded all the same." }]);
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
