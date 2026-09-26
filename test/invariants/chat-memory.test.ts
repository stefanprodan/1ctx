// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { open } from "../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import { savedWords } from "../../src/server/memory/index.ts";
import {
  MEMORY,
  MEMORY_OFF_LINE,
  VISUALIZE_OFF_LINE,
} from "../../src/shared/capabilities.ts";
import type { MemoryEntry } from "../../src/shared/contracts/memory.ts";
import type { Message } from "../../src/shared/contracts/session.ts";
import { testApp } from "../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  type Script,
  scriptedFetch,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { fileDb } from "../helpers/db.ts";

const BLOCK = "Project memory, notes this project's chats saved.";

type Edit = Record<string, unknown>;

async function settled(chat: Pick<ChatApp, "app">, id: string) {
  for (let i = 0; i < 400; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

const note = (chat: Pick<ChatApp, "app" | "projectId">) =>
  chat.app.memory.read({ projectId: chat.projectId, automationId: null });

const promptOf = (script: Script) =>
  (script.body.messages as { content: string }[])[0]!.content;

const toolNames = (script: Script) =>
  ((script.body.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

// the results of the calls with these ids, in the request that follows
function results(script: Script, ids: string[]): string[] {
  const messages = script.body.messages as {
    role: string;
    tool_call_id?: string;
    content: string;
  }[];
  return ids.map(
    (id) =>
      messages.find((m) => m.role === "tool" && m.tool_call_id === id)!.content,
  );
}

const call = (id: string, args: Edit) => ({
  id,
  name: "memory_edit",
  arguments: JSON.stringify(args),
});

// a message in a chat, or a new chat: the first request's script
async function message(
  chat: ChatApp,
  sessionId: string | null,
  text = "remember this",
  client = chat.member,
): Promise<{ sessionId: string; script: Script }> {
  if (sessionId === null) {
    const started = await startChat(chat, text, client);
    return { sessionId: started.sessionId, script: started.script };
  }
  const pending = chat.scripted.next();
  const response = await client.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message: text } },
  );
  expect(response.status).toBe(201);
  return { sessionId, script: await pending };
}

// a send whose rounds each call memory_edit with the edits given, then
// answers; the first request's prompt and every round's results
async function saves(
  chat: ChatApp,
  sessionId: string | null,
  rounds: Edit[][],
): Promise<{ sessionId: string; prompt: string; results: string[][] }> {
  const first = await message(chat, sessionId);
  let script = first.script;
  const out: string[][] = [];
  for (const [r, edits] of rounds.entries()) {
    const ids = edits.map((_, i) => `r${r}c${i}-${crypto.randomUUID()}`);
    const count = chat.scripted.scripts.length;
    script.toolRound(edits.map((edit, i) => call(ids[i]!, edit)));
    script.end();
    script = await waitScript(chat.scripted, count + 1);
    out.push(results(script, ids));
  }
  script.reply("done");
  await settled(chat, first.sessionId);
  return {
    sessionId: first.sessionId,
    prompt: promptOf(first.script),
    results: out,
  };
}

// a chat's first send, answered with no call
async function quiet(chat: ChatApp, sessionId: string | null = null) {
  const sent = await message(chat, sessionId, "hello");
  sent.script.reply("hi");
  await settled(chat, sent.sessionId);
  return { sessionId: sent.sessionId, prompt: promptOf(sent.script) };
}

const views = (chat: Pick<ChatApp, "app">, sessionId: string) =>
  chat.app.db
    .query<{ n: number }, [string]>(
      "select count(*) as n from memory_views where session_id = ?",
    )
    .get(sessionId)!.n;

const entry = (topic: string, text: string): MemoryEntry => ({ topic, text });

describe("a chat saves to the project's memory", () => {
  test.serial(
    "a save lands at once with one revision and one event; an equal one writes nothing",
    async () => {
      const chat = await chatApp();
      const events: BusEvent[] = [];
      const off = subscribe((event) => {
        if (event.type === "memory.changed") events.push(event);
      }, silent);
      try {
        const { sessionId, script } = await message(chat, null);
        expect(toolNames(script)).toContain("memory_edit");
        const count = chat.scripted.scripts.length;
        script.toolRound([
          call("save", { action: "set", topic: "Units", text: "Use metric." }),
        ]);
        script.end();
        const second = await waitScript(chat.scripted, count + 1);
        // saved while the send still runs
        expect(chat.app.sessions.byId(sessionId)!.status).toBe("running");
        expect(note(chat)).toMatchObject({
          entries: [entry("Units", "Use metric.")],
          previous: [],
          revision: 1,
          updatedBy: chat.memberId,
          sessionId,
        });
        expect(results(second, ["save"])).toEqual([
          savedWords([entry("Units", "Use metric.")]),
        ]);
        expect(events).toEqual([
          {
            type: "memory.changed",
            data: {
              projectId: chat.projectId,
              automationId: null,
              revision: 1,
            },
          },
        ]);
        second.reply("Saved.");
        await settled(chat, sessionId);

        const again = await saves(chat, sessionId, [
          [{ action: "set", topic: "units", text: "Use metric." }],
        ]);
        expect(again.results).toEqual([
          [savedWords([entry("Units", "Use metric.")])],
        ]);
        expect(note(chat).revision).toBe(1);
        expect(events).toHaveLength(1);
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );

  test("a chat never overwrites what it did not see", async () => {
    const chat = await chatApp();
    try {
      const a = (await quiet(chat)).sessionId;
      const b = (
        await saves(chat, null, [
          [{ action: "set", topic: "Units", text: "metric" }],
        ])
      ).sessionId;
      // another chat's write to the topic is refused with its text, and
      // the retry over what the refusal showed applies
      const refused = await saves(chat, a, [
        [{ action: "set", topic: "Units", text: "imperial" }],
        [{ action: "set", topic: "Units", text: "metric and imperial" }],
      ]);
      expect(refused.results[0]![0]).toStartWith(
        "Error: Another chat wrote the topic Units since this chat last saw it.",
      );
      expect(refused.results[0]![0]).toContain("1. Units [6/500]\nmetric\n");
      expect(refused.results[1]![0]).toStartWith("Saved to the project's");
      expect(note(chat)).toMatchObject({
        entries: [entry("Units", "metric and imperial")],
        revision: 2,
        sessionId: a,
      });
      // a write to another topic applies over a stale view
      await saves(chat, b, [[{ action: "set", topic: "Time", text: "UTC" }]]);
      expect(note(chat).revision).toBe(3);
      // the other chat's remove is refused first, then applies
      const removed = await saves(chat, b, [
        [{ action: "remove", topic: "Units" }],
        [{ action: "remove", topic: "Units" }],
      ]);
      expect(removed.results[0]![0]).toContain(
        "Another chat wrote the topic Units",
      );
      expect(removed.results[1]![0]).toStartWith("Saved to the project's");
      expect(note(chat).revision).toBe(4);
      // a remove of a topic removed elsewhere is a success with no write
      const gone = await saves(chat, a, [
        [{ action: "remove", topic: "Units" }],
      ]);
      expect(gone.results[0]![0]).toBe(savedWords([entry("Time", "UTC")]));
      expect(note(chat)).toMatchObject({
        entries: [entry("Time", "UTC")],
        revision: 4,
        sessionId: b,
      });
      // a refusal that lists the note makes all of it seen
      const c = (await quiet(chat)).sessionId;
      await saves(chat, b, [
        [{ action: "set", topic: "Owner", text: "team a" }],
      ]);
      const listed = await saves(chat, c, [
        [{ action: "remove", topic: "Nothing" }],
        [{ action: "set", topic: "Owner", text: "team b" }],
      ]);
      expect(listed.results[0]![0]).toStartWith(
        "Error: No entry has topic Nothing.",
      );
      expect(listed.results[0]![0]).toContain("team a");
      expect(listed.results[1]![0]).toStartWith("Saved to the project's");
      expect(note(chat).entries).toEqual([
        entry("Time", "UTC"),
        entry("Owner", "team b"),
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a retry that repeats the refused text is refused until it merges", async () => {
    const chat = await chatApp();
    try {
      const a = (await quiet(chat)).sessionId;
      await saves(chat, null, [
        [{ action: "set", topic: "Units", text: "metric" }],
      ]);
      const retried = await saves(chat, a, [
        [{ action: "set", topic: "Units", text: "imperial" }],
        [{ action: "set", topic: "Units", text: "imperial" }],
        [{ action: "set", topic: "Units", text: "metric and imperial" }],
      ]);
      expect(retried.results[0]![0]).toContain("Another chat wrote the topic");
      expect(retried.results[1]![0]).toStartWith(
        "Error: This is the text refused for Units.",
      );
      expect(retried.results[1]![0]).toContain("1. Units [6/500]\nmetric\n");
      // the unmerged retry is no failed round, so the tool is still there
      expect(retried.results[2]![0]).toStartWith("Saved to the project's");
      expect(note(chat).entries).toEqual([
        entry("Units", "metric and imperial"),
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a set refused because the topic was removed may be sent again as it was", async () => {
    const chat = await chatApp();
    try {
      const b = (
        await saves(chat, null, [
          [{ action: "set", topic: "Units", text: "metric" }],
        ])
      ).sessionId;
      await saves(chat, null, [[{ action: "remove", topic: "Units" }]]);
      const again = await saves(chat, b, [
        [{ action: "set", topic: "Units", text: "metric and kelvin" }],
        [{ action: "set", topic: "Units", text: "metric and kelvin" }],
      ]);
      expect(again.results[0]![0]).toContain("Another chat removed the topic");
      expect(again.results[1]![0]).toStartWith("Saved to the project's");
      expect(note(chat).entries).toEqual([entry("Units", "metric and kelvin")]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a regenerate forgets what the dropped turn saved", async () => {
    const chat = await chatApp();
    try {
      const a = (
        await saves(chat, null, [
          [{ action: "set", topic: "Units", text: "metric, per the user" }],
        ])
      ).sessionId;
      // the regenerated turn no longer shows the save, so a set of the
      // topic is refused with its text rather than replacing it unseen
      const count = chat.scripted.scripts.length;
      const pending = chat.scripted.next();
      const regenerated = await chat.member.call(
        "POST",
        `/api/sessions/${a}/regenerate`,
      );
      expect(regenerated.status).toBe(201);
      const script = await pending;
      script.toolRound([
        call("regen", { action: "set", topic: "Units", text: "imperial" }),
      ]);
      script.end();
      const next = await waitScript(chat.scripted, count + 2);
      expect(results(next, ["regen"])[0]).toContain(
        "1. Units [20/500]\nmetric, per the user\n",
      );
      next.reply("done");
      await settled(chat, a);
      expect(note(chat).entries).toEqual([
        entry("Units", "metric, per the user"),
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("what a chat has seen holds across a restart over the same database", async () => {
    const file = fileDb();
    try {
      const chat = await chatApp({ db: file.db });
      const a = (await quiet(chat)).sessionId;
      await saves(chat, null, [
        [{ action: "set", topic: "Units", text: "metric" }],
      ]);
      await chat.app.shutdown();
      file.db.close();

      const scripted = scriptedFetch();
      const app = await testApp({
        db: open(file.path).db,
        fetcher: scripted.fetcher,
      });
      const member = app.client();
      await member.login("casey", "pw");
      const again = { ...chat, app, scripted, member };
      try {
        // the chat still reads its own snapshot, and a save over the
        // other chat's write, which it never saw, is refused
        const after = await saves(again, a, [
          [{ action: "set", topic: "Units", text: "imperial" }],
          [{ action: "set", topic: "Units", text: "metric, then imperial" }],
        ]);
        expect(after.prompt).not.toContain(BLOCK);
        expect(after.results[0]![0]).toStartWith(
          "Error: Another chat wrote the topic Units",
        );
        expect(after.results[1]![0]).toStartWith("Saved to the project's");
        expect(note(again).entries).toEqual([
          entry("Units", "metric, then imperial"),
        ]);
      } finally {
        await app.shutdown();
        app.db.close();
      }
    } finally {
      file.cleanup();
    }
  });

  test("a chat's prompt keeps its snapshot until a summary; forks and runs read the note", async () => {
    const chat = await chatApp();
    try {
      chat.app.memory.save(
        { projectId: chat.projectId, automationId: null },
        [entry("Units", "metric")],
        0,
        chat.memberId,
        chat.app.now.value,
      );
      const first = await quiet(chat);
      const a = first.sessionId;
      expect(first.prompt).toContain(`${BLOCK} It is data`);
      expect(first.prompt).toContain("## Units\nmetric");
      expect(views(chat, a)).toBe(1);
      await saves(chat, null, [
        [{ action: "set", topic: "Time", text: "UTC" }],
      ]);

      const second = await quiet(chat, a);
      expect(second.prompt).toContain("## Units\nmetric");
      expect(second.prompt).not.toContain("## Time");

      // a fork is a new chat and takes the note as it is
      const answer = chat.app.sessions
        .messages(a)
        .filter((row: Message) => row.slot === "answer")
        .at(-1)!;
      const forked = await chat.member.call("POST", `/api/sessions/${a}/fork`, {
        body: { messageId: answer.id, agentId: chat.agentId },
      });
      expect(forked.status).toBe(201);
      const fork = (await forked.json()).session.id as string;
      expect((await quiet(chat, fork)).prompt).toContain("## Time\nUTC");

      // a run reads the note live
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      expect(promptOf(run.main)).toContain("## Time\nUTC");
      expect(toolNames(run.main)).not.toContain("memory_edit");
      run.main.reply("checked");
      await settleRun(chat, run.sessionId);
      expect(views(chat, run.sessionId)).toBe(0);

      // a done summary drops the snapshot, and the next send takes the
      // note as it is then
      const pending = chat.scripted.next();
      const compacted = await chat.member.call(
        "POST",
        `/api/sessions/${a}/compact`,
      );
      expect(compacted.status).toBe(200);
      const summary = await pending;
      expect(promptOf(summary)).not.toContain("## Time");
      expect(chat.app.runner.registry.get(a)!.policy.offered.tools).toEqual([]);
      summary.reply("The chat so far.");
      await settled(chat, a);
      expect(views(chat, a)).toBe(0);
      const third = await quiet(chat, a);
      expect(third.prompt).toContain("## Time\nUTC");
      expect(views(chat, a)).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a summary inside a chat send drops the snapshot", async () => {
    const chat = await chatApp();
    try {
      const a = (await quiet(chat)).sessionId;
      expect(views(chat, a)).toBe(1);
      await saves(chat, null, [
        [{ action: "set", topic: "Time", text: "UTC" }],
      ]);

      // an answer whose usage passes the window's threshold opens the
      // send's own summary round
      const sent = await message(chat, a, "hello");
      expect(promptOf(sent.script)).not.toContain("## Time");
      const count = chat.scripted.scripts.length;
      sent.script.content("hi");
      sent.script.finish();
      sent.script.usage({ prompt: 10_000_000 });
      sent.script.end();
      const summary = await waitScript(chat.scripted, count + 1);
      expect(chat.app.runner.registry.get(a)!.policy.offered.tools).not.toEqual(
        [],
      );
      summary.reply("The chat so far.");
      await settled(chat, a);
      const summaries = chat.app.sessions
        .messages(a)
        .filter((row: Message) => row.kind === "summary");
      expect(summaries.map((row) => row.status)).toEqual(["done"]);
      expect(views(chat, a)).toBe(0);

      const next = await quiet(chat, a);
      expect(next.prompt).toContain("## Time\nUTC");
      expect(views(chat, a)).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a stop, a failure, a regenerate and a delete keep what was saved", async () => {
    const chat = await chatApp();
    try {
      // stopped after the save
      const { sessionId: a, script } = await message(chat, null);
      const count = chat.scripted.scripts.length;
      script.toolRound([
        call("one", { action: "set", topic: "Units", text: "metric" }),
      ]);
      script.end();
      await waitScript(chat.scripted, count + 1);
      const stop = await chat.member.call("POST", `/api/sessions/${a}/stop`);
      expect(stop.status).toBe(200);
      await settled(chat, a);
      expect(chat.app.sessions.byId(a)!.status).toBe("stopped");
      expect(note(chat)).toMatchObject({ revision: 1, sessionId: a });

      // regenerated: the turn that saved is gone, the save is not
      const pending = chat.scripted.next();
      const regenerated = await chat.member.call(
        "POST",
        `/api/sessions/${a}/regenerate`,
      );
      expect(regenerated.status).toBe(201);
      (await pending).reply("again");
      await settled(chat, a);
      expect(note(chat)).toMatchObject({
        entries: [entry("Units", "metric")],
        revision: 1,
      });

      // failed after the save
      const failing = await message(chat, a);
      chat.scripted.refuse(500, "boom");
      failing.script.toolRound([
        call("two", { action: "set", topic: "Time", text: "UTC" }),
      ]);
      failing.script.end();
      await settled(chat, a);
      expect(chat.app.sessions.byId(a)!.status).toBe("failed");
      expect(note(chat)).toMatchObject({ revision: 2, sessionId: a });

      const memoryPath = `/api/projects/${chat.projectId}/memory`;
      expect(
        (await (await chat.member.call("GET", memoryPath)).json()).memory,
      ).toMatchObject({
        updatedBy: { id: chat.memberId },
        session: { id: a, origin: "chat", automationId: null },
      });

      // deleted: the note stays, no longer naming the chat
      expect(views(chat, a)).toBe(1);
      const deleted = await chat.member.call("DELETE", `/api/sessions/${a}`);
      expect(deleted.status).toBe(200);
      expect(views(chat, a)).toBe(0);
      expect(note(chat)).toMatchObject({
        entries: [entry("Units", "metric"), entry("Time", "UTC")],
        revision: 2,
        sessionId: null,
      });
      expect(
        (await (await chat.member.call("GET", memoryPath)).json()).memory,
      ).toMatchObject({ updatedBy: { id: chat.memberId }, session: null });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the memory switch drops the tool, keeps the note and says so", async () => {
    const chat = await chatApp();
    try {
      chat.app.memory.save(
        { projectId: chat.projectId, automationId: null },
        [entry("Units", "metric")],
        0,
        chat.memberId,
        chat.app.now.value,
      );
      const pending = chat.scripted.next();
      const created = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
          capabilities: { disable: [MEMORY, "visualize"] },
        },
      });
      expect(created.status).toBe(201);
      const sessionId = (await created.json()).session.id as string;
      const script = await pending;
      expect(toolNames(script)).not.toContain("memory_edit");
      expect(toolNames(script)).toContain("bash");
      const prompt = promptOf(script);
      expect(prompt).toContain("## Units\nmetric");
      expect(prompt.indexOf(MEMORY_OFF_LINE)).toBeGreaterThan(
        prompt.indexOf(VISUALIZE_OFF_LINE),
      );
      expect(prompt.indexOf(VISUALIZE_OFF_LINE)).toBeGreaterThan(0);
      const count = chat.scripted.scripts.length;
      script.toolRound([
        call("anyway", { action: "set", topic: "Units", text: "imperial" }),
      ]);
      script.end();
      const next = await waitScript(chat.scripted, count + 1);
      expect(results(next, ["anyway"])).toEqual([
        'Error: tool "memory_edit" not found.',
      ]);
      next.reply("ok");
      await settled(chat, sessionId);
      expect(note(chat).revision).toBe(1);

      // a run is never offered it, and the key means nothing there
      const automation = await createAutomation(chat, {
        disabledCapabilities: [MEMORY],
      });
      const run = await startRun(chat, automation.id);
      expect(toolNames(run.main)).not.toContain("memory_edit");
      expect(promptOf(run.main)).not.toContain(MEMORY_OFF_LINE);
      run.main.reply("checked");
      await settleRun(chat, run.sessionId);

      // nor is a model without tools, which reads the note all the same
      const plain = await chat.makeAgent({ name: "plain", model: NO_TOOLS });
      const started = await startChat(
        chat,
        "hello",
        chat.member,
        chat.projectId,
        plain,
      );
      expect(toolNames(started.script)).toEqual([]);
      expect(promptOf(started.script)).toContain("## Units\nmetric");
      started.script.reply("hi");
      await settled(chat, started.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("two failed rounds of saves stop the tool for the rest of the send", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, script } = await message(chat, null);
      let current = script;
      for (const id of ["first", "second"]) {
        const count = chat.scripted.scripts.length;
        current.toolRound([call(id, { action: "set", topic: "Units" })]);
        current.end();
        current = await waitScript(chat.scripted, count + 1);
        expect(results(current, [id])[0]).toStartWith(
          "Error: text must be text.",
        );
      }
      expect(toolNames(current)).not.toContain("memory_edit");
      expect(toolNames(current)).toContain("bash");
      const count = chat.scripted.scripts.length;
      current.toolRound([
        call("third", { action: "set", topic: "Units", text: "metric" }),
      ]);
      current.end();
      const last = await waitScript(chat.scripted, count + 1);
      expect(results(last, ["third"])).toEqual([
        "Error: Memory tools stopped after 2 failed rounds. Finish without memory tools.",
      ]);
      last.reply("done");
      await settled(chat, sessionId);
      expect(note(chat).revision).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });
});
