// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat message whose first word is @name gets one turn from that
// agent: the turn runs on it, the next plain message on the chat's
// agent, each reads the other's answer and trace but never its work,
// the queue gives a summon its own turn, and regenerate, compaction,
// the cache key, the MCP note, a memory save and the retire count
// follow the turn's agent.

import { describe, expect, test } from "bun:test";
import { SUMMARY_LEAD } from "../../../src/server/runner/context.ts";
import { summonedLine } from "../../../src/server/runner/prompt.ts";
import { TRACE_HEADING } from "../../../src/server/runner/trace.ts";
import { envelopeRow } from "../../../src/server/sessions/stream.ts";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  type Script,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

type WireMessage = {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: { function: { name: string } }[];
  tool_call_id?: string;
  reasoning_content?: string;
};

// the request's messages after the system prompt, as the wire took them
const turns = (script: Script) =>
  (script.body.messages as WireMessage[]).slice(1).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tool_calls === undefined
      ? {}
      : { calls: message.tool_calls.map((call) => call.function.name) }),
    ...(message.tool_call_id === undefined ? {} : { result: true }),
  }));

const system = (script: Script) =>
  (script.body.messages as WireMessage[])[0]!.content as string;

// until the chat's lock is let go, so the next message is a turn
async function free(chat: ChatApp, sessionId: string) {
  await settleRun(chat, sessionId);
  for (let i = 0; i < 400; i++) {
    if (chat.app.runner.registry.get(sessionId) === null) return;
    await tick();
  }
  throw new Error("the lock was not let go");
}

async function post(chat: ChatApp, sessionId: string, message: string) {
  return chat.member.call("POST", `/api/sessions/${sessionId}/messages`, {
    body: { message },
  });
}

// a message to a free chat, its turn's script
async function turn(chat: ChatApp, sessionId: string, message: string) {
  await free(chat, sessionId);
  const count = chat.scripted.scripts.length;
  const response = await post(chat, sessionId, message);
  if (response.status !== 201) {
    throw new Error(
      `send answered ${response.status}: ${await response.text()}`,
    );
  }
  return waitScript(chat.scripted, count + 1);
}

const sends = (chat: ChatApp, sessionId: string) =>
  chat.app.db
    .query<{ agent_id: string; summoned: number }, [string]>(
      "select agent_id, summoned from sends where session_id = ? order by started_at, rowid",
    )
    .all(sessionId);

// a whole round with the usage given
function answer(
  script: Script,
  text: string,
  usage: { prompt: number; completion: number },
) {
  script.content(text);
  script.finish();
  script.usage(usage);
  script.end();
}

// a chat whose first turn on coder called datetime, then answered
async function checkedChat(chat: ChatApp) {
  const started = await startChat(chat, "what time is it");
  started.script.reasoning("let me look");
  started.script.toolRound([
    { id: "c1", name: "datetime", arguments: '{"timezone":"UTC"}' },
  ]);
  started.script.end();
  const answer = await waitScript(chat.scripted, 2);
  answer.reply("it is noon");
  return started.sessionId;
}

async function summonApp() {
  const chat = await chatApp();
  const checkerId = await chat.makeAgent({ name: "checker", model: FLASH });
  return { chat, checkerId };
}

describe("a summon", () => {
  test("runs one turn on the summoned agent and the next on the chat's", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const sessionId = await checkedChat(chat);
      const summoned = await turn(chat, sessionId, "@Checker is that right");
      expect(system(summoned)).toStartWith("You are checker,");
      expect(system(summoned)).toContain(summonedLine("coder"));
      expect(turns(summoned)).toEqual([
        { role: "user", content: "what time is it", name: "casey" },
        { role: "user", content: "[coder] it is noon" },
        {
          role: "user",
          content: `${TRACE_HEADING}\ndatetime timezone=UTC ok`,
        },
        { role: "user", content: "@Checker is that right", name: "casey" },
      ]);
      expect(summoned.body.prompt_cache_key).toBe(`${sessionId}:${checkerId}`);
      summoned.reply("yes, noon");

      const next = await turn(chat, sessionId, "thanks");
      expect(system(next)).toStartWith("You are coder,");
      expect(system(next)).not.toContain("summoned");
      expect(turns(next)).toEqual([
        { role: "user", content: "what time is it", name: "casey" },
        { role: "assistant", content: null, calls: ["datetime"] },
        {
          role: "tool",
          content: expect.stringContaining("UTC") as unknown as string,
          result: true,
        },
        { role: "assistant", content: "it is noon" },
        { role: "user", content: "@Checker is that right", name: "casey" },
        { role: "user", content: "[checker] yes, noon" },
        { role: "user", content: "thanks", name: "casey" },
      ]);
      expect(next.body.prompt_cache_key).toBe(sessionId);
      next.reply("welcome");
      await free(chat, sessionId);
      expect(sends(chat, sessionId)).toEqual([
        { agent_id: chat.agentId, summoned: 0 },
        { agent_id: checkerId, summoned: 1 },
        { agent_id: chat.agentId, summoned: 0 },
      ]);
      // the chat keeps its agent, and a summoned reply names its own
      const detail = await (
        await chat.member.call("GET", `/api/sessions/${sessionId}`)
      ).json();
      expect(detail.session.agentId).toBe(chat.agentId);
      expect(
        detail.messages
          .filter((row: { slot: string }) => row.slot === "answer")
          .map((row: { agentId: string }) => row.agentId),
      ).toEqual([chat.agentId, checkerId, chat.agentId]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a second summon of the same agent reads its own turn whole", async () => {
    const { chat } = await summonApp();
    try {
      const sessionId = await checkedChat(chat);
      const first = await turn(chat, sessionId, "@checker look");
      first.toolRound([{ id: "k1", name: "datetime", arguments: "{}" }]);
      first.end();
      (await waitScript(chat.scripted, 4)).reply("checked");
      const again = await turn(chat, sessionId, "@checker again");
      expect(turns(again)).toEqual([
        { role: "user", content: "what time is it", name: "casey" },
        { role: "user", content: "[coder] it is noon" },
        {
          role: "user",
          content: `${TRACE_HEADING}\ndatetime timezone=UTC ok`,
        },
        { role: "user", content: "@checker look", name: "casey" },
        { role: "assistant", content: null, calls: ["datetime"] },
        {
          role: "tool",
          content: expect.any(String) as unknown as string,
          result: true,
        },
        { role: "assistant", content: "checked" },
        { role: "user", content: "@checker again", name: "casey" },
      ]);
      again.reply("still");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a fork onto another agent sends the chat's turns as its own", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const sessionId = await checkedChat(chat);
      await free(chat, sessionId);
      const rows = chat.app.sessions.messages(sessionId);
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: rows.at(-1)!.id, agentId: checkerId } },
      );
      expect(forked.status).toBe(201);
      const fork = (await forked.json()).session.id as string;
      const next = await turn(chat, fork, "go on");
      expect(system(next)).toStartWith("You are checker,");
      expect(turns(next).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      next.reply("ok");
      await free(chat, fork);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an unknown name is refused on a send, in the queue and on a new chat", async () => {
    const { chat } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "hello");
      const queued = await post(chat, sessionId, "@glm check");
      expect(queued.status).toBe(400);
      expect((await queued.json()).error).toBe("no agent named glm");
      expect(
        chat.app.db.query("select count(*) as n from queued_messages").get(),
      ).toEqual({ n: 0 });
      script.reply("hi");
      await free(chat, sessionId);
      const sent = await post(chat, sessionId, "@Glm check");
      expect(sent.status).toBe(400);
      expect((await sent.json()).error).toBe("no agent named Glm");
      // the chat's own name is an ordinary turn
      const own = await turn(chat, sessionId, "@coder go on");
      expect(system(own)).toStartWith("You are coder,");
      own.reply("going");
      await free(chat, sessionId);
      for (const message of ["@glm hi", "@checker hi"]) {
        const started = await chat.member.call("POST", "/api/sessions", {
          body: { projectId: chat.projectId, agentId: chat.agentId, message },
        });
        expect(started.status).toBe(400);
        expect((await started.json()).error).toBe(
          `no agent named ${message.slice(1, -3)}`,
        );
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial("a queued summon is a turn of its own, in order", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "first");
      for (const message of ["one", "@checker two", "three"]) {
        expect((await post(chat, sessionId, message)).status).toBe(202);
      }
      script.reply("done");
      const plain = await waitScript(chat.scripted, 2);
      expect(system(plain)).toStartWith("You are coder,");
      expect(turns(plain).at(-1)).toEqual({
        role: "user",
        content: "one",
        name: "casey",
      });
      plain.reply("one done");
      const summoned = await waitScript(chat.scripted, 3);
      expect(system(summoned)).toStartWith("You are checker,");
      expect(turns(summoned).at(-1)).toEqual({
        role: "user",
        content: "@checker two",
        name: "casey",
      });
      summoned.reply("two done");
      const last = await waitScript(chat.scripted, 4);
      expect(system(last)).toStartWith("You are coder,");
      expect(turns(last).slice(-2)).toEqual([
        { role: "user", content: "[checker] two done" },
        { role: "user", content: "three", name: "casey" },
      ]);
      last.reply("three done");
      await free(chat, sessionId);
      expect(sends(chat, sessionId)).toEqual([
        { agent_id: chat.agentId, summoned: 0 },
        { agent_id: chat.agentId, summoned: 0 },
        { agent_id: checkerId, summoned: 1 },
        { agent_id: chat.agentId, summoned: 0 },
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "a queued summon of an agent retired since turns not sent",
    async () => {
      const { chat, checkerId } = await summonApp();
      try {
        const { sessionId, script } = await startChat(chat, "first");
        expect((await post(chat, sessionId, "@checker two")).status).toBe(202);
        const retired = await chat.admin.call(
          "DELETE",
          `/api/agents/${checkerId}`,
        );
        expect(retired.status).toBe(200);
        script.reply("done");
        await free(chat, sessionId);
        await tick();
        expect(
          chat.app.db.query("select state, reason from queued_messages").all(),
        ).toEqual([{ state: "not-sent", reason: "agent-deleted" }]);
        const home = await (
          await chat.member.call("GET", "/api/me/not-sent")
        ).json();
        expect(home.rows.map((row: { agent: string }) => row.agent)).toEqual([
          "checker",
        ]);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("regenerate reruns a summoned turn on its agent; a retired one is gone", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker check");
      summoned.reply("fine");
      await free(chat, sessionId);
      const count = chat.scripted.scripts.length;
      const again = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/regenerate`,
      );
      expect(again.status).toBe(201);
      const rerun = await waitScript(chat.scripted, count + 1);
      expect(system(rerun)).toStartWith("You are checker,");
      expect(system(rerun)).toContain(summonedLine("coder"));
      rerun.reply("fine again");
      await free(chat, sessionId);
      expect(sends(chat, sessionId).at(-1)).toEqual({
        agent_id: checkerId,
        summoned: 1,
      });
      expect(
        (await chat.admin.call("DELETE", `/api/agents/${checkerId}`)).status,
      ).toBe(200);
      const gone = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/regenerate`,
      );
      expect(gone.status).toBe(400);
      expect((await gone.json()).error).toBe("checker is gone");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a summoned turn never compacts, and a chat past its window is refused", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      chat.app.db
        .query("update agents set context_length = 1000 where id = ?")
        .run(checkerId);
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker check");
      summoned.content("fine");
      summoned.finish();
      summoned.usage({ prompt: 950, completion: 10 });
      summoned.end();
      await free(chat, sessionId);
      expect(
        chat.app.sessions
          .messages(sessionId)
          .filter((row) => row.kind === "summary"),
      ).toEqual([]);
      // the meter keeps the chat agent's last round
      expect(chat.app.sessions.byId(sessionId)!.usage?.promptTokens).toBe(10);
      const refused = await post(chat, sessionId, "@checker again");
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe(
        "the chat is too long for checker",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the retire count names a summoned turn running in another chat", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker check");
      const impact = await (
        await chat.admin.call("GET", `/api/agents/${checkerId}/impact`)
      ).json();
      expect(impact).toMatchObject({ chats: 0, running: 1 });
      // the feed row names the running turn's agent
      const list = await (
        await chat.member.call("GET", `/api/sessions?project=${chat.projectId}`)
      ).json();
      expect(list.rows[0].sendAgent).toEqual({
        name: "checker",
        retired: false,
      });
      expect(envelopeRow(chat.app.db, sessionId)?.sendAgent).toEqual({
        name: "checker",
        retired: false,
      });
      summoned.reply("fine");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a memory save in a summoned turn records the summoned agent", async () => {
    const { chat } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker remember");
      summoned.toolRound([
        {
          id: "m1",
          name: "memory_edit",
          arguments: '{"action":"set","topic":"Pods","text":"nine pods"}',
        },
      ]);
      summoned.end();
      (await waitScript(chat.scripted, 3)).reply("saved");
      await free(chat, sessionId);
      const note = await (
        await chat.member.call("GET", `/api/projects/${chat.projectId}/memory`)
      ).json();
      expect(note.memory.entries).toEqual([
        { topic: "Pods", text: "nine pods" },
      ]);
      expect(note.memory.agentName).toBe("checker");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the MCP note compares a send with the same agent's last", async () => {
    {
      const { chat, checkerId } = await summonApp();
      try {
        const { sessionId, script } = await startChat(chat, "hello");
        script.reply("hi");
        await free(chat, sessionId);
        const store = chat.app.sessions;
        const digest = (tool: string) => ({
          srv: { tools: { [tool]: "h" }, instructions: "" },
        });
        for (const [agentId, tool] of [
          [chat.agentId, "a"],
          [checkerId, "b"],
          [chat.agentId, "c"],
        ] as const) {
          store.createSend({
            sessionId,
            userId: chat.memberId,
            agentId,
            providerId: chat.providerId,
            model: FLASH,
            firstMessageId: "m",
            mcpDigest: digest(tool),
            now: chat.app.now.value,
          });
        }
        expect(store.lastMcpDigest(sessionId, "none", checkerId)).toEqual(
          digest("b"),
        );
        expect(store.lastMcpDigest(sessionId, "none", chat.agentId)).toEqual(
          digest("c"),
        );
      } finally {
        await chat.app.shutdown();
      }
    }
  });

  test("a compacted chat is counted by its summary, asked or automatic", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const window = (id: string) =>
        chat.app.db
          .query("update agents set context_length = 1000 where id = ?")
          .run(id);
      window(checkerId);
      const { sessionId, script } = await startChat(chat, "hello");
      answer(script, "hi", { prompt: 900, completion: 10 });
      await free(chat, sessionId);
      expect((await post(chat, sessionId, "@checker check")).status).toBe(400);
      const count = chat.scripted.scripts.length;
      const compacted = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/compact`,
      );
      expect(compacted.status).toBe(200);
      const summary = await waitScript(chat.scripted, count + 1);
      answer(summary, "the summary", { prompt: 910, completion: 40 });
      const asked = await turn(chat, sessionId, "@checker check");
      expect(turns(asked)[0]!.content).toStartWith(SUMMARY_LEAD);
      asked.reply("fine");
      await free(chat, sessionId);

      // the chat's agent compacts by itself past its own window
      window(chat.agentId);
      const long = await turn(chat, sessionId, "go on");
      answer(long, "long", { prompt: 900, completion: 10 });
      const automatic = await waitScript(chat.scripted, count + 4);
      answer(automatic, "second summary", { prompt: 920, completion: 30 });
      const after = await turn(chat, sessionId, "@checker again");
      expect(turns(after)).toEqual([
        { role: "user", content: `${SUMMARY_LEAD}\n\nsecond summary` },
        { role: "user", content: "@checker again", name: "casey" },
      ]);
      after.reply("fine again");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a regenerate leaves the replaced turn's rounds out of the count", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      chat.app.db
        .query("update agents set context_length = 1000 where id = ?")
        .run(checkerId);
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker check");
      answer(summoned, "fine", { prompt: 950, completion: 10 });
      await free(chat, sessionId);
      const count = chat.scripted.scripts.length;
      const again = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/regenerate`,
      );
      expect(again.status).toBe(201);
      (await waitScript(chat.scripted, count + 1)).reply("fine again");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a fork keeps a summoned turn and each agent's view of it", async () => {
    const { chat, checkerId } = await summonApp();
    try {
      const sessionId = await checkedChat(chat);
      const summoned = await turn(chat, sessionId, "@checker look");
      summoned.toolRound([{ id: "k1", name: "datetime", arguments: "{}" }]);
      summoned.end();
      (await waitScript(chat.scripted, 4)).reply("checked");
      await free(chat, sessionId);
      const rows = chat.app.sessions.messages(sessionId);
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/fork`,
        { body: { messageId: rows.at(-1)!.id, agentId: chat.agentId } },
      );
      expect(forked.status).toBe(201);
      const fork = (await forked.json()).session.id as string;
      expect(sends(chat, fork)).toEqual([
        { agent_id: chat.agentId, summoned: 0 },
        { agent_id: checkerId, summoned: 1 },
      ]);
      const own = await turn(chat, fork, "next");
      expect(turns(own).slice(-5)).toEqual([
        { role: "assistant", content: "it is noon" },
        { role: "user", content: "@checker look", name: "casey" },
        { role: "user", content: "[checker] checked" },
        { role: "user", content: `${TRACE_HEADING}\ndatetime ok` },
        { role: "user", content: "next", name: "casey" },
      ]);
      own.reply("noted");
      const again = await turn(chat, fork, "@checker again");
      expect(turns(again)).toEqual([
        { role: "user", content: "what time is it", name: "casey" },
        { role: "user", content: "[coder] it is noon" },
        {
          role: "user",
          content: `${TRACE_HEADING}\ndatetime timezone=UTC ok`,
        },
        { role: "user", content: "@checker look", name: "casey" },
        { role: "assistant", content: null, calls: ["datetime"] },
        {
          role: "tool",
          content: expect.any(String) as unknown as string,
          result: true,
        },
        { role: "assistant", content: "checked" },
        { role: "user", content: "next", name: "casey" },
        { role: "user", content: "[coder] noted" },
        { role: "user", content: "@checker again", name: "casey" },
      ]);
      again.reply("same");
      await free(chat, fork);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("two summoned agents see each other's turns as foreign", async () => {
    const { chat } = await summonApp();
    try {
      await chat.makeAgent({ name: "auditor", model: FLASH });
      const sessionId = await checkedChat(chat);
      const first = await turn(chat, sessionId, "@checker look");
      first.toolRound([{ id: "k1", name: "datetime", arguments: "{}" }]);
      first.end();
      (await waitScript(chat.scripted, 4)).reply("checked");
      const second = await turn(chat, sessionId, "@auditor audit");
      expect(system(second)).toStartWith("You are auditor,");
      expect(turns(second)).toEqual([
        { role: "user", content: "what time is it", name: "casey" },
        { role: "user", content: "[coder] it is noon" },
        {
          role: "user",
          content: `${TRACE_HEADING}\ndatetime timezone=UTC ok`,
        },
        { role: "user", content: "@checker look", name: "casey" },
        { role: "user", content: "[checker] checked" },
        { role: "user", content: `${TRACE_HEADING}\ndatetime ok` },
        { role: "user", content: "@auditor audit", name: "casey" },
      ]);
      second.reply("audited");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a stopped summoned turn with no answer leaves its trace alone", async () => {
    const { chat } = await summonApp();
    try {
      const { sessionId, script } = await startChat(chat, "hello");
      script.reply("hi");
      const summoned = await turn(chat, sessionId, "@checker look");
      summoned.toolRound([{ id: "k1", name: "datetime", arguments: "{}" }]);
      summoned.end();
      await waitScript(chat.scripted, 3);
      const stopped = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/stop`,
      );
      expect(stopped.status).toBe(200);
      const next = await turn(chat, sessionId, "go on");
      expect(turns(next)).toEqual([
        { role: "user", content: "hello", name: "casey" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "@checker look", name: "casey" },
        { role: "user", content: `${TRACE_HEADING}\ndatetime ok` },
        { role: "user", content: "go on", name: "casey" },
      ]);
      next.reply("ok");
      await free(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
