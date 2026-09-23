// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tool loop as a state machine, driven through the composed app: the
// scripted provider streams a round's calls in the OpenAI shape, the real
// tools area runs them (the datetime tool with no network, the search tools
// through the fake fetch that fails every host but the provider's), and
// the runner drives round after round to the answer. Every assertion is
// on the rows the server wrote and the send it ended: the slot per reply,
// the round numbers, the tool rows, the counters and the terminal cause.

import { describe, expect, test } from "bun:test";
import { LOOP_LINE } from "../../src/server/runner/context.ts";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import { NOT_RUN_LOOP } from "../../src/server/runner/writer.ts";
import { settleRun } from "../helpers/automations.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";
import {
  answerNodes,
  asksAnswer,
  settle,
  shape,
  time,
} from "../helpers/tool-loop.ts";

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
        calls: ["datetime"],
      },
      {
        kind: "tool",
        slot: null,
        round: 1,
        status: "done",
        toolName: "datetime",
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
    // the datetime tool answers a JSON object with the timezone it was asked
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
        calls: ["datetime"],
      },
      {
        kind: "tool",
        slot: null,
        round: 1,
        status: "done",
        toolName: "datetime",
        calls: null,
      },
      {
        kind: "reply",
        slot: "work",
        round: 2,
        status: "done",
        toolName: null,
        calls: ["datetime"],
      },
      {
        kind: "tool",
        slot: null,
        round: 2,
        status: "done",
        toolName: "datetime",
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
    script.toolRound([{ id: "c1", name: "datetime", arguments: "{not json" }]);
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

  test("the answer round keeps the schemas and asks for the answer in words", async () => {
    const chat = await chatApp();
    const { detail, sessionId } = await startChat(chat, "cap then answer");
    // over the per-round cap: the calls are recorded not run and the
    // loop enters the answer round, which asks for the answer in words
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      time(`c${i}`, `Etc/GMT+${(i % 12) + 1}`),
    );
    chat.scripted.scripts[0].toolRound(many);
    chat.scripted.scripts[0].end();
    // the answer round: the provider calls anyway, so a local server is
    // asked the same way again, then once more with no schemas
    const answer = await chat.scripted.next();
    answer.toolRound([time("again")]);
    answer.end();
    const repeat = await chat.scripted.next();
    repeat.toolRound([time("twice")]);
    repeat.end();
    const bare = await chat.scripted.next();
    // a provider past all three still ends the send on the cap
    bare.toolRound([time("still")]);
    bare.end();
    await settle(chat, 10);
    const answerReq = chat.scripted.scripts[1].body;
    // the schemas stay untouched so the cached prefix holds
    expect((answerReq.tools as unknown[]).length).toBeGreaterThan(0);
    expect(asksAnswer(answerReq)).toBe(true);
    expect(asksAnswer(chat.scripted.scripts[2].body)).toBe(true);
    const bareReq = chat.scripted.scripts[3].body;
    expect(bareReq.tools).toBeUndefined();
    expect(bareReq.tool_choice).toBeUndefined();
    expect(chat.scripted.scripts).toHaveLength(4);
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

  test("a hosted wire goes from the answer round straight to no schemas", async () => {
    const chat = await chatApp({ wire: "gemini" });
    const { sessionId } = await startChat(chat, "cap on gemini");
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      time(`c${i}`, `Etc/GMT+${(i % 12) + 1}`),
    );
    chat.scripted.scripts[0].toolRound(many);
    chat.scripted.scripts[0].end();
    const answer = await chat.scripted.next();
    answer.toolRound([time("again")]);
    answer.end();
    const bare = await chat.scripted.next();
    expect(bare.body.tools).toBeUndefined();
    bare.reply("answered without tools");
    await settle(chat, 10);
    expect(chat.scripted.scripts).toHaveLength(3);
    expect(
      chat.app.sessions
        .messages(sessionId)
        .filter((r) => r.kind === "reply")
        .map((r) => r.finishReason),
    ).toEqual(["tool_limit", "tool_limit", "stop"]);
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
    // loop check, which records the calls not run and asks for the answer
    for (let round = 1; round <= 3; round++) {
      const script = await waitScript(chat.scripted, round);
      script.toolRound([time("same")]);
      script.end();
      await settle(chat);
    }
    const answer = await waitScript(chat.scripted, 4);
    expect(asksAnswer(answer.body, LOOP_LINE)).toBe(true);
    answer.reply("the answer after the loop");
    await settle(chat, 10);
    const send = chat.app.sessions.send(detail.send.id)!;
    expect(send.status).toBe("done");
    const rows = chat.app.sessions.messages(sessionId);
    const replies = rows.filter((r) => r.kind === "reply");
    expect(replies.at(-2)!.finishReason).toBe("tool_loop");
    expect(replies.at(-1)!.content).toBe("the answer after the loop");
    expect(rows.filter((r) => r.kind === "tool").at(-1)).toMatchObject({
      status: "stopped",
      content: NOT_RUN_LOOP,
    });
    answerNodes(chat, sessionId);
    chat.app.socket.dispose();
  });

  test("the round cap ends the loop after MAX_ROUNDS and lands on an answer", async () => {
    const chat = await chatApp();
    try {
      const { detail, sessionId } = await startChat(chat, "many");
      for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
        const script = await waitScript(chat.scripted, round);
        if (round === LOOP_LIMITS.rounds) {
          expect(asksAnswer(script.body)).toBe(true);
          script.reply("done after the cap");
        } else {
          expect(asksAnswer(script.body)).toBe(false);
          script.toolRound([time(`c${round}`, `Etc/GMT+${(round % 12) + 1}`)]);
          script.end();
        }
      }
      expect((await settleRun(chat, sessionId))?.status).toBe("done");
      const send = chat.app.sessions.send(detail.send.id)!;
      expect(send.rounds).toBe(LOOP_LIMITS.rounds);
      const replies = chat.app.sessions
        .messages(sessionId)
        .filter((r) => r.kind === "reply");
      expect(replies.at(-2)?.finishReason).toBe("tool_limit");
      expect(replies.at(-1)?.finishReason).toBe("stop");
      answerNodes(chat, sessionId);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
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
});
