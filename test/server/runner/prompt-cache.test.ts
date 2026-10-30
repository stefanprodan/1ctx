// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Claude turns that read the previous turn's cache: the cache life of
// each kind of send, a plain chat whose tools and system hold across a
// moved repository, and a channel whose next turn by the same agent
// repeats the stream up to its mark.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { adapter, threadJobs } from "../../../src/server/repos/index.ts";
import { cacheLife } from "../../../src/server/runner/round.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  expectMarkRules,
  expectPrefix,
  flatBlocks,
  lastHourAt,
  lastMarkAt,
  marksOf,
} from "../../helpers/cache-marks.ts";
import { channelApp } from "../../helpers/channel.ts";
import {
  ANTHROPIC_MODEL,
  type ChatApp,
  chatApp,
  idle,
  type Script,
  sessionSettled,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import {
  COMMIT,
  cacheDir,
  fakeHost,
  type HostAnswer,
  NEXT_COMMIT,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";
import { allowSubagents, delegateCall } from "../../helpers/subagents.ts";

const URL = "https://github.com/acme/widgets";
const ARCHIVE = adapter(URL, "github").archiveUrl("");
const HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE = { type: "ephemeral" };
const MOVED = "repo widgets: default branch moved from 3e0ff8a to 8d01e44";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tree = (commit: string) =>
  tarResponse(
    tarball([{ name: "README.md", body: "# widgets\n" }], { comment: commit }),
    `"${commit.slice(0, 4)}"`,
  );

// the repository's answers, which a test moves to the next commit
function repoHost() {
  const dir = cacheDir();
  dirs.push(dir);
  const answers: Record<string, HostAnswer> = { [ARCHIVE]: tree(COMMIT) };
  return {
    answers,
    options: {
      cacheDir: dir,
      repoJobs: threadJobs(fakeHost(answers).fetch),
    },
  };
}

function addRepo(chat: ChatApp, projectId: string) {
  chat.app.repos.store.create(
    projectId,
    {
      name: "widgets",
      url: URL,
      kind: "github",
      ref: "",
      keyName: null,
      ignore: "",
    },
    chat.app.now.value,
  );
}

const body = (script: Script) => script.body as Record<string, any>;
const textAt = (script: Script, at: number) =>
  String(flatBlocks(body(script))[at]?.text);

describe("the cache life of a send", () => {
  const send = (over: Record<string, unknown> = {}) =>
    ({
      child: null,
      summarizing: false,
      kind: "chat",
      phase: "provider",
      channel: null,
      op: "message",
      ...over,
      policy: { subagent: false, summoned: null, ...(over.policy ?? {}) },
    }) as Parameters<typeof cacheLife>[0];
  const parent = {};

  test.each([
    ["a chat", send(), "long"],
    ["a summoned turn", send({ policy: { summoned: "coder" } }), "long"],
    ["a regenerate", send({ op: "regenerate" }), "long"],
    ["a channel turn", send({ channel: {} }), "channel"],
    ["a run", send({ kind: "run" }), "short"],
    [
      "a chat's child",
      send({ child: { parent }, policy: { subagent: true } }),
      "short",
    ],
    [
      "a run's child",
      send({ kind: "run", child: { parent }, policy: { subagent: true } }),
      "short",
    ],
    [
      "a channel turn's child",
      send({ channel: {}, child: { parent }, policy: { subagent: true } }),
      "short",
    ],
    ["an automatic summary", send({ summarizing: true }), "short"],
    [
      "a summary on demand",
      send({ kind: "compact", summarizing: true }),
      "short",
    ],
    ["a memory step", send({ kind: "run", phase: "memory" }), "short"],
    ["an attention step", send({ kind: "run", phase: "attention" }), "short"],
  ] as const)("%s", (_, of, life) => {
    expect(cacheLife(of)).toBe(life);
  });

  test("reaches the request: an hour in a chat, five minutes in its summary and child", async () => {
    const chat = await chatApp({ wire: "anthropic" });
    try {
      chat.app.automationScheduler.stop();
      allowSubagents(chat, chat.agentId);
      const { script, sessionId } = await startChat(chat);
      expect(marksOf(body(script)).map((m) => m.mark)).toEqual([HOUR, HOUR]);
      script.toolRound([delegateCall("d1", "Look around.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(JSON.stringify(child.body)).not.toContain("ttl");
      child.reply("looked");
      const answer = await waitScript(chat.scripted, 3);
      expect(marksOf(body(answer)).every((m) => m.mark.ttl === "1h")).toBe(
        true,
      );
      answer.reply("done");
      await sessionSettled(chat.app, sessionId);
      const compacted = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/compact`,
      );
      expect(compacted.status).toBe(200);
      const summary = await waitScript(chat.scripted, 4);
      expect(JSON.stringify(summary.body)).not.toContain("ttl");
      summary.reply("the summary");
      await sessionSettled(chat.app, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run's body carries no hour", async () => {
    const chat = await chatApp({ wire: "anthropic" });
    try {
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      expect(marksOf(body(run.main)).map((m) => m.mark)).toEqual([FIVE, FIVE]);
      expect(JSON.stringify(run.main.body)).not.toContain("ttl");
      run.main.reply("done");
      await settleRun(chat, run.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a plain chat on claude", () => {
  test("two turns over a moved repository share tools, system and the first's last request", async () => {
    const host = repoHost();
    const chat = await chatApp({ wire: "anthropic", ...host.options });
    try {
      addRepo(chat, chat.projectId);
      const { script, sessionId } = await startChat(chat);
      script.toolRound([
        {
          id: "call-1",
          name: "bash",
          arguments: JSON.stringify({
            command: "cat /repos/widgets/README.md",
          }),
        },
      ]);
      script.end();
      const last = await waitScript(chat.scripted, 2);
      last.reply("first");
      await sessionSettled(chat.app, sessionId);

      chat.app.now.value += 61_000;
      host.answers[ARCHIVE] = tree(NEXT_COMMIT);
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/messages`,
        { body: { message: "again" } },
      );
      expect(response.status).toBe(201);
      const next = await waitScript(chat.scripted, 3);
      const at = lastMarkAt(body(last));
      expectPrefix(body(next), body(last), at);
      // the next turn's marks still reach back to it
      const marks = flatBlocks(body(next)).flatMap((block, i) =>
        block.cache_control && i >= at ? [i] : [],
      );
      expect(marks[0]! - at).toBeLessThan(20);
      for (const one of [script, last, next]) {
        expectMarkRules(body(one));
        expect(marksOf(body(one)).every((m) => m.mark.ttl === "1h")).toBe(true);
      }
      // the move is said in the turn's own text, never the system
      expect(JSON.stringify(body(next).system)).not.toContain("moved");
      const texts = flatBlocks(body(next)).map((block) => String(block.text));
      expect(texts.filter((text) => text.includes(MOVED))).toHaveLength(1);
      expect(texts.indexOf("[casey] again")).toBe(
        texts.findIndex((text) => text.includes(MOVED)) + 1,
      );
      next.reply("second");
      await sessionSettled(chat.app, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a plain chat's next request on claude", () => {
  const send = async (chat: ChatApp, sessionId: string, path: string) => {
    const count = chat.scripted.scripts.length + 1;
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/${path}`,
      { body: path === "messages" ? { message: "again" } : {} },
    );
    expect(response.status).toBe(201);
    return waitScript(chat.scripted, count);
  };

  test("repeats a turn whose round thought, its signed thinking included", async () => {
    const chat = await chatApp({ wire: "anthropic" });
    try {
      const { script, sessionId } = await startChat(chat);
      script.reasoning("first thought");
      script.sse(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"first-signature"}}\n\n',
      );
      script.toolRound([
        {
          id: "call-1",
          name: "bash",
          arguments: JSON.stringify({ command: "echo hi" }),
        },
      ]);
      script.end();
      const last = await waitScript(chat.scripted, 2);
      expect(JSON.stringify(last.body.messages)).toContain("first-signature");
      last.reply("first");
      await sessionSettled(chat.app, sessionId);
      const next = await send(chat, sessionId, "messages");
      expect(JSON.stringify(next.body.messages)).toContain("first-signature");
      expectPrefix(body(next), body(last), lastMarkAt(body(last)));
      expectMarkRules(body(next));
      next.reply("second");
      await sessionSettled(chat.app, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a regenerate repeats the request of the turn it replaces", async () => {
    const chat = await chatApp({ wire: "anthropic" });
    try {
      const { script, sessionId } = await startChat(chat);
      script.reply("first");
      await sessionSettled(chat.app, sessionId);
      const second = await send(chat, sessionId, "messages");
      second.reply("second");
      await sessionSettled(chat.app, sessionId);
      const again = await send(chat, sessionId, "regenerate");
      expectPrefix(body(again), body(second), lastMarkAt(body(second)));
      expect(body(again)).toEqual(body(second));
      again.reply("second again");
      await sessionSettled(chat.app, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a channel on claude", () => {
  const claudeChannel = (options: Parameters<typeof chatApp>[0] = {}) =>
    channelApp({ wire: "anthropic", model: ANTHROPIC_MODEL, ...options });

  test("the next turn of an agent repeats the stream up to the mark, with and without its whole last turn", async () => {
    const { chat, post, summon } = await claudeChannel();
    try {
      const turns: Script[] = [];
      const ask = async (text: string) => {
        const { script } = await summon("coder", text);
        turns.push(script);
        return script;
      };
      const answer = async (script: Script, text: string) => {
        script.reply(text);
        await idle(chat.app);
      };
      expect((await post("hello")).status).toBe(201);
      const first = await ask("one");
      // no own turn yet: the mark ends the stream
      expect(textAt(first, lastHourAt(body(first)))).toContain("hello");
      await answer(first, "answer one");
      expect((await post("more")).status).toBe(201);
      const second = await ask("two");
      expectPrefix(body(second), body(first), lastHourAt(body(first)));
      // turn one replays whole, so the mark sits before it
      expect(textAt(second, lastHourAt(body(second)))).toContain("hello");
      await answer(second, "answer two");
      expect((await post("extra")).status).toBe(201);
      const third = await ask("three");
      expectPrefix(body(third), body(second), lastHourAt(body(second)));
      expect(textAt(third, lastHourAt(body(third)))).toContain("more");
      await answer(third, "answer three");
      const fourth = await ask("four");
      expectPrefix(body(fourth), body(third), lastHourAt(body(third)));
      expect(textAt(fourth, lastHourAt(body(fourth)))).toContain("extra");
      await answer(fourth, "answer four");
      for (const script of turns) {
        expectMarkRules(body(script));
        expect(body(script).system[0].cache_control).toEqual(HOUR);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an empty stream has only the system mark for an hour", async () => {
    const { chat, summon } = await claudeChannel();
    try {
      const { script } = await summon("coder", "first");
      expect(marksOf(body(script))).toEqual([
        { at: "system", mark: HOUR },
        { at: expect.stringContaining("first"), mark: FIVE },
      ]);
      script.reply("done");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a traced own turn marks its stream's end and the turn's own entry, one tail mark", async () => {
    const { chat, post, summon } = await claudeChannel();
    try {
      expect((await post("hello")).status).toBe(201);
      const first = await summon("coder", "one");
      first.script.reply("answer one");
      await idle(chat.app);
      chat.app.db
        .query("update sends set swept = 1 where id = ?")
        .run(first.send.id);
      expect((await post("more")).status).toBe(201);
      const second = await summon("coder", "two");
      const turns = body(second.script).messages as { role: string }[];
      expect(turns.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      // turn one cached up to its stream's end, before its own post
      expect(marksOf(body(second.script))).toEqual([
        { at: "system", mark: HOUR },
        { at: expect.stringContaining("hello"), mark: HOUR },
        { at: expect.stringContaining("more"), mark: HOUR },
        { at: expect.stringContaining("two"), mark: FIVE },
      ]);
      const at = lastHourAt(body(first.script));
      expectPrefix(body(second.script), body(first.script), at);
      expect(flatBlocks(body(second.script))[at]!.cache_control).toEqual(HOUR);
      second.script.reply("answer two");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a long stream between two turns keeps a mark where the last turn wrote", async () => {
    const { chat, post, summon } = await claudeChannel();
    try {
      const between = async (tag: string) => {
        for (let i = 0; i < 30; i++) {
          expect((await post(`${tag} post ${i}`)).status).toBe(201);
        }
        for (let i = 0; i < 3; i++) {
          const other = await summon("reviewer", `${tag} review ${i}`);
          other.script.reply(`${tag} reviewed ${i}`);
          await idle(chat.app);
        }
      };
      expect((await post("hello")).status).toBe(201);
      const first = await summon("coder", "one");
      first.script.reply("answer one");
      await idle(chat.app);
      await between("a");
      const second = await summon("coder", "two");
      second.script.reply("answer two");
      await idle(chat.app);
      await between("b");
      const third = await summon("coder", "three");
      // the second turn wrote at its one stream mark, before turn one
      const wrote = lastHourAt(body(second.script));
      expect(textAt(second.script, wrote)).toContain("hello");
      expectPrefix(body(third.script), body(second.script), wrote);
      expect(flatBlocks(body(third.script))[wrote]!.cache_control).toEqual(
        HOUR,
      );
      // its own stream mark is past the lookback from there
      expect(lastHourAt(body(third.script)) - wrote).toBeGreaterThan(20);
      expect(marksOf(body(third.script)).map((m) => m.mark)).toEqual([
        HOUR,
        HOUR,
        HOUR,
        FIVE,
      ]);
      for (const script of [first, second, third]) {
        expectMarkRules(body(script.script));
      }
      third.script.reply("answer three");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a moved drop mark misses the cache, by design", async () => {
    const { chat, channelId, post, summon } = await claudeChannel();
    try {
      expect((await post("hello")).status).toBe(201);
      const first = await summon("coder", "one");
      first.script.reply("answer one");
      await idle(chat.app);
      expect((await post("more")).status).toBe(201);
      const more = chat.app.sessions
        .messages(channelId)
        .findLast((row) => row.content === "more")!;
      chat.app.db
        .query("update sessions set dropped_seq = ? where id = ?")
        .run(more.seq, channelId);
      const second = await summon("coder", "two");
      const texts = JSON.stringify(flatBlocks(body(second.script)));
      expect(texts).not.toContain("hello");
      expect(textAt(second.script, lastHourAt(body(second.script)))).toContain(
        "more",
      );
      expectMarkRules(body(second.script));
      second.script.reply("answer two");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a turn after a repository moved is told, in its local message", async () => {
    const host = repoHost();
    const { chat, project, summon } = await claudeChannel(host.options);
    try {
      addRepo(chat, project.id);
      const local = (script: Script) =>
        flatBlocks(body(script))
          .map((block) => String(block.text))
          .find((text) => text.startsWith("You talk to @"))!;
      const first = await summon("coder", "one");
      expect(local(first.script)).toContain(
        "Repositories mounted for this turn:\n/repos/widgets: github.com/acme/widgets at default branch (3e0ff8a)",
      );
      expect(local(first.script)).not.toContain("moved");
      first.script.reply("answer one");
      await idle(chat.app);
      chat.app.now.value += 61_000;
      host.answers[ARCHIVE] = tree(NEXT_COMMIT);
      const second = await summon("coder", "two");
      expect(local(second.script)).toContain(MOVED);
      expect(JSON.stringify(body(second.script).tools)).not.toContain(
        "8d01e44",
      );
      second.script.reply("answer two");
      await idle(chat.app);
    } finally {
      await chat.app.shutdown();
    }
  });
});
