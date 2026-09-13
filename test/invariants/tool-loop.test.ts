// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool loop as a state machine, driven through the composed app: the
// scripted provider streams a round's calls in the OpenAI shape, the real
// tools area runs them (the time tool with no network, the search tools
// through the fake fetch that fails every host but the provider's), and
// the runner drives round after round to the answer. Every assertion is
// on the rows the server wrote and the send it ended: the slot per reply,
// the round numbers, the tool rows, the counters and the terminal cause.
// A model without the tools flag is offered none; a search key removed
// after the policy was built is a failed result.

import { describe, expect, test } from "bun:test";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";

// let the loop settle: each tool round crosses several microtasks and a
// db transaction, so a few ticks cover the round and the next request.
// The fake clock is nudged so a finalize retry (clock.sleep) resolves
// rather than hanging the test
async function settle(chat: ChatApp, times = 6) {
  for (let i = 0; i < times; i++) {
    await tick();
    chat.app.now.value += 200;
    await tick();
  }
}

// the message rows of a session, shaped for a compact assertion
function shape(chat: ChatApp, sessionId: string) {
  return chat.app.sessions.messages(sessionId).map((row) => ({
    kind: row.kind,
    slot: row.slot,
    round: row.round,
    status: row.status,
    toolName: row.toolName,
    calls: row.toolCalls?.map((c) => c.name) ?? null,
  }));
}

// the answer node invariant of decision 7, replayed on the final rows:
// per send, outside the fold there is the user row and at most one
// reply node, whose row has slot answer or is streaming with a null
// slot; every work reply and every tool row is inside the fold
function answerNodes(chat: ChatApp, sessionId: string) {
  const rows = chat.app.sessions.messages(sessionId);
  const bySend = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySend.get(row.sendId) ?? [];
    list.push(row);
    bySend.set(row.sendId, list);
  }
  for (const [, list] of bySend) {
    const outside = list.filter(
      (row) =>
        row.kind === "user" ||
        (row.kind === "reply" &&
          (row.slot === "answer" ||
            (row.status === "streaming" && row.slot === null))),
    );
    expect(outside.filter((row) => row.kind === "user")).toHaveLength(1);
    expect(
      outside.filter((row) => row.kind === "reply").length,
    ).toBeLessThanOrEqual(1);
    expect(outside.map((row) => row.kind)).toEqual(
      outside.length === 1 ? ["user"] : ["user", "reply"],
    );
  }
}

const time = (id: string, tz = "UTC") => ({
  id,
  name: "get_current_time",
  arguments: JSON.stringify({ timezone: tz }),
});

describe("the tool loop", () => {
  test("a plain reply on a tools model runs no round", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "hi");
    // the tools flag is on, so the request carries the schemas
    expect((script.body.tools as unknown[]).length).toBeGreaterThan(0);
    script.reply("hello");
    await settle(chat);
    expect(shape(chat, sessionId)).toEqual([
      {
        kind: "user",
        slot: null,
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
      {
        kind: "reply",
        slot: "answer",
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
    ]);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({
      status: "done",
      cause: "finish",
      rounds: 1,
      toolCalls: 0,
    });
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("thinking then an answer keeps the reply outside the fold", async () => {
    const chat = await chatApp();
    const { sessionId } = await startChat(chat, "hi");
    const script = chat.scripted.scripts[0];
    script.reasoning("hmm");
    script.reply("the answer");
    await settle(chat);
    const rows = shape(chat, sessionId);
    expect(rows[1]).toMatchObject({ kind: "reply", slot: "answer", round: 1 });
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("a model without the tools flag is offered none and behaves as before", async () => {
    const chat = await chatApp({ model: NO_TOOLS });
    const { detail, script, sessionId } = await startChat(chat, "hi");
    expect(script.body.tools).toBeUndefined();
    script.reply("plain");
    await settle(chat);
    expect(shape(chat, sessionId)).toEqual([
      {
        kind: "user",
        slot: null,
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
      {
        kind: "reply",
        slot: "answer",
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
    ]);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(0);
    chat.app.socket.dispose();
  });

  test("one tool round then an answer: work reply, tool row, answer reply", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(
      chat,
      "what time is it",
    );
    script.reasoning("let me check");
    script.toolRound([time("call_1")]);
    script.end();
    const round2 = await chat.scripted.next();
    round2.reply("It is noon.");
    await settle(chat);
    expect(shape(chat, sessionId)).toEqual([
      {
        kind: "user",
        slot: null,
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
      {
        kind: "reply",
        slot: "work",
        round: 1,
        status: "done",
        toolName: null,
        calls: ["get_current_time"],
      },
      {
        kind: "tool",
        slot: null,
        round: 1,
        status: "done",
        toolName: "get_current_time",
        calls: null,
      },
      {
        kind: "reply",
        slot: "answer",
        round: 2,
        status: "done",
        toolName: null,
        calls: null,
      },
    ]);
    const toolRow = chat.app.sessions.messages(sessionId)[2]!;
    // the time tool answers a JSON object with the timezone it was asked
    expect(toolRow.content).toContain("UTC");
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({
      status: "done",
      cause: "finish",
      rounds: 2,
      toolCalls: 1,
    });
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("two tool rounds then an answer: a new reply id in round 2 and round 3", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "twice");
    script.toolRound([time("c1")]);
    script.end();
    const r2 = await chat.scripted.next();
    r2.toolRound([time("c2", "Asia/Tokyo")]);
    r2.end();
    const r3 = await chat.scripted.next();
    r3.reply("done at last");
    await settle(chat, 10);
    const rows = shape(chat, sessionId);
    expect(rows).toEqual([
      {
        kind: "user",
        slot: null,
        round: 1,
        status: "done",
        toolName: null,
        calls: null,
      },
      {
        kind: "reply",
        slot: "work",
        round: 1,
        status: "done",
        toolName: null,
        calls: ["get_current_time"],
      },
      {
        kind: "tool",
        slot: null,
        round: 1,
        status: "done",
        toolName: "get_current_time",
        calls: null,
      },
      {
        kind: "reply",
        slot: "work",
        round: 2,
        status: "done",
        toolName: null,
        calls: ["get_current_time"],
      },
      {
        kind: "tool",
        slot: null,
        round: 2,
        status: "done",
        toolName: "get_current_time",
        calls: null,
      },
      {
        kind: "reply",
        slot: "answer",
        round: 3,
        status: "done",
        toolName: null,
        calls: null,
      },
    ]);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "done", rounds: 3, toolCalls: 2 });
    expect(
      chat.app.usage.forSession(sessionId).map((row) => row.round),
    ).toEqual([1, 2, 3]);
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("narration before a call moves the reply into the fold with its text", async () => {
    const chat = await chatApp();
    const { sessionId } = await startChat(chat, "when");
    const script = chat.scripted.scripts[0];
    script.content("I will check the clock.");
    script.toolRound([time("c1")]);
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("noon");
    await settle(chat);
    const work = chat.app.sessions.messages(sessionId)[1]!;
    expect(work.slot).toBe("work");
    expect(work.content).toBe("I will check the clock.");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("parallel calls in one round each get a tool row", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "several");
    script.toolRound([
      time("c1", "UTC"),
      time("c2", "Asia/Tokyo"),
      time("c3", "Europe/Paris"),
    ]);
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("all done");
    await settle(chat, 10);
    const rows = chat.app.sessions.messages(sessionId);
    const toolRows = rows.filter((r) => r.kind === "tool");
    expect(toolRows).toHaveLength(3);
    expect(toolRows.every((r) => r.round === 1)).toBe(true);
    expect(chat.app.sessions.send(detail.send.id)!.toolCalls).toBe(3);
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("an unknown tool is a failed row whose text the model still gets", async () => {
    const chat = await chatApp();
    const { sessionId } = await startChat(chat, "call nothing");
    const script = chat.scripted.scripts[0];
    script.toolRound([{ id: "c1", name: "does_not_exist", arguments: "{}" }]);
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("recovered");
    await settle(chat);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    expect(toolRow.content.toLowerCase()).toContain("not found");
    // the model was called again with the tool result in the history
    expect(chat.app.sessions.messages(sessionId).at(-1)!.slot).toBe("answer");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("malformed arguments are a failed row, never a throw", async () => {
    const chat = await chatApp();
    const { sessionId } = await startChat(chat, "bad args");
    const script = chat.scripted.scripts[0];
    script.toolRound([
      { id: "c1", name: "get_current_time", arguments: "{not json" },
    ]);
    script.end();
    const r2 = await chat.scripted.next();
    r2.reply("ok");
    await settle(chat);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("failed");
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("done");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("the answer round keeps the schemas and forbids a call with tool_choice none", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "cap then answer");
    // over the per-round cap: the calls are recorded not run and the
    // loop enters the answer round, which is sent tool_choice none
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      time(`c${i}`, `Etc/GMT+${(i % 12) + 1}`),
    );
    chat.scripted.scripts[0].toolRound(many);
    chat.scripted.scripts[0].end();
    // the answer round: the provider calls anyway, which ends tool_limit
    const answer = await chat.scripted.next();
    answer.toolRound([time("again")]);
    answer.end();
    await settle(chat, 10);
    const answerReq = chat.scripted.scripts[1].body;
    // the schemas stay so the cached prefix holds, tool_choice forbids
    expect((answerReq.tools as unknown[]).length).toBeGreaterThan(0);
    expect(answerReq.tool_choice).toBe("none");
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    const lastReply = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply")
      .at(-1)!;
    expect(lastReply.finishReason).toBe("tool_limit");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("a finish reason other than stop or tool_calls with calls ends on it", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "cut round");
    const script = chat.scripted.scripts[0];
    // a length finish with the call partially assembled
    script.toolCall(time("c1"));
    script.finish("length");
    script.usage();
    script.end();
    await settle(chat);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    const reply = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "reply")!;
    expect(reply.finishReason).toBe("length");
    // the calls were recorded, not run: their tool rows are stopped
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool");
    expect(toolRow?.status).toBe("stopped");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("three identical rounds in a row are the loop check", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "loop");
    // three rounds asking for the very same call; the third trips the
    // loop check, which records the calls not run and ends tool_loop
    for (let round = 1; round <= 3; round++) {
      const script = await waitScript(chat.scripted, round);
      script.toolRound([time("same")]);
      script.end();
      await settle(chat);
    }
    await settle(chat, 10);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    const lastReply = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply")
      .at(-1)!;
    expect(lastReply.finishReason).toBe("tool_loop");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("the round cap ends the loop after MAX_ROUNDS and lands on an answer", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "many");
    // every work round asks for a fresh distinct call so the loop check
    // never trips; the cap reserves MAX_ROUNDS for the answer round
    for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
      const send = chat.app.sessions.send(detail.send.id)!;
      if (send.status !== "running") break;
      const script = await waitScript(chat.scripted, round);
      if (round === LOOP_LIMITS.rounds) {
        script.reply("done after the cap");
      } else {
        script.toolRound([time(`c${round}`, `Etc/GMT+${(round % 12) + 1}`)]);
        script.end();
      }
      await settle(chat);
    }
    await settle(chat, 10);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    expect(send.rounds).toBe(LOOP_LIMITS.rounds);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    // a reply carries the cap's finish reason where the loop cut it
    expect(replies.some((r) => r.finishReason === "tool_limit")).toBe(true);
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("the call cap cuts a round over the per-round limit", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "too many at once");
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      time(`c${i}`, `Etc/GMT+${(i % 12) + 1}`),
    );
    chat.scripted.scripts[0].toolRound(many);
    chat.scripted.scripts[0].end();
    // over the per-round cap: the calls are recorded not run, the loop
    // goes to the answer round
    const r2 = await chat.scripted.next();
    r2.reply("answered without the tools");
    await settle(chat, 10);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    expect(send.toolCalls).toBe(0);
    const toolRows = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "tool");
    expect(toolRows.length).toBe(many.length);
    expect(toolRows.every((r) => r.status === "stopped")).toBe(true);
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("a stop during a work round's text ends the send stopped", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "stop me");
    script.content("thinking about a tool");
    script.toolCall(time("c1"));
    await tick();
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await settle(chat);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "stopped", cause: "stop" });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("stopped");
    expect(script.aborted).toBe(true);
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("a provider failure in round 2 after a tool ends the send failed", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "fail later");
    script.toolRound([time("c1")]);
    script.end();
    const r2 = await chat.scripted.next();
    // round 2 ends the stream with no finish: the wire reports it early
    r2.content("partial");
    r2.end();
    await settle(chat);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "failed", cause: "failure" });
    // the first round's tool row still ran and is done
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.status).toBe("done");
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("shutdown during the loop ends the send stopped by shutdown", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "shut");
    script.toolRound([time("c1")]);
    script.end();
    // let the first round's tool run and round 2 start
    await settle(chat);
    await chat.app.shutdown();
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send).toMatchObject({ status: "stopped", cause: "shutdown" });
    expect(chat.app.sessions.byId(sessionId)!.status).toBe("stopped");
    answerNodes(chat, sessionId);
  });

  test("websearch is not offered without a key (decision 3)", async () => {
    const chat = await chatApp({ secrets: {} });
    const { script } = await startChat(chat, "search");
    const tools = (script.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(tools).toContain("get_current_time");
    expect(tools).toContain("webfetch");
    expect(tools).not.toContain("websearch");
    script.reply("no search offered");
    await settle(chat);
    chat.app.socket.dispose();
  });

  test("the search provider is chosen once per send, from the key present when it began", async () => {
    // exa.key exists when the send begins, so websearch is offered and
    // the provider is chosen exa for the send's life (decision 3); the
    // snapshot rides on the policy, so removing the key afterwards does
    // not change what was offered. The per-call failure a removed key
    // causes is exercised by the tools unit suite, which threads a fake
    // fetch; here the request the send carries proves the snapshot.
    const chat = await chatApp({ secrets: { exa: "exa-key" } });
    const { script } = await startChat(chat, "search please");
    const offered = (script.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(offered).toContain("websearch");
    // the key is gone now, but the send already holds its snapshot
    delete chat.secrets.exa;
    // a fresh send, begun after the removal, is offered no websearch
    script.reply("ok");
    await settle(chat);
    const again = await startChat(chat, "search again");
    const laterOffered = (
      again.script.body.tools as { function: { name: string } }[]
    ).map((t) => t.function.name);
    expect(laterOffered).not.toContain("websearch");
    again.script.reply("no search now");
    await settle(chat);
    chat.app.socket.dispose();
  });

  test("with a search key websearch is offered", async () => {
    const chat = await chatApp({ secrets: { exa: "exa-key" } });
    const { script } = await startChat(chat, "search please");
    const tools = (script.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(tools).toContain("websearch");
    script.reply("ok");
    await settle(chat);
    chat.app.socket.dispose();
  });
});
