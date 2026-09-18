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
// A model without the tools flag is offered none; a search key removed
// after the policy was built is a failed result.

import { describe, expect, test } from "bun:test";
import { geminiEvents } from "../../src/server/providers/index.ts";
import { parseSse } from "../../src/server/providers/openai.ts";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
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
  name: "datetime",
  arguments: JSON.stringify({ timezone: tz }),
});

async function chooseSearch(chat: ChatApp, provider: "exa" | "firecrawl") {
  const res = await chat.admin.call("PATCH", "/api/tools/websearch", {
    body: { provider },
  });
  expect(res.status).toBe(200);
}

describe("the tool loop", () => {
  test.each(["chat", "automation"] as const)(
    "bash reads, edits and deletes project files as the %s's agent",
    async (origin) => {
      const chat = await chatApp();
      try {
        const created = await chat.member.call(
          "POST",
          `/api/projects/${chat.projectId}/knowledge`,
          { body: { name: "docs/x.md", text: "hello\n" } },
        );
        expect(created.status).toBe(201);
        const { file } = await created.json();
        const started =
          origin === "chat"
            ? await startChat(chat)
            : await startRun(
                chat,
                (await createAutomation(chat, { ownMemory: true })).id,
              ).then(({ sessionId, main }) => ({ sessionId, script: main }));
        const { sessionId, script } = started;
        expect(
          (script.body.tools as { function: { name: string } }[]).map(
            (tool) => tool.function.name,
          ),
        ).toEqual(["datetime", "webfetch", "visualize", "bash"]);
        const prompt = (script.body.messages as { content: string }[])[0]!
          .content;
        const bash = (id: string, command: string) => ({
          id,
          name: "bash",
          arguments: JSON.stringify({ command }),
        });
        script.toolRound([bash("read", "grep -n hello docs/x.md")]);
        script.end();
        const second = await waitScript(chat.scripted, 2);
        expect(second.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "read",
          content: "1:hello\n\nexit 0",
        });
        second.toolRound([bash("edit", "sed -i 's/hello/world/' docs/x.md")]);
        second.end();
        const third = await waitScript(chat.scripted, 3);
        const author = {
          kind: "agent",
          id: chat.agentId,
          name: "coder",
          sessionId,
          origin,
        };
        expect(chat.app.knowledge.read(chat.projectId, file.id)).toMatchObject({
          text: "world\n",
          revision: 2,
          lines: 1,
          author,
        });
        const edited = chat.app.sessions
          .messages(sessionId)
          .find((row) => row.toolCallId === "edit")!;
        expect(edited.status).toBe("done");
        expect(edited.content).toEndWith("wrote docs/x.md (rev 2, 1 lines)");
        expect(third.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "edit",
          content: edited.content,
        });
        expect((third.body.messages as { content: string }[])[0]!.content).toBe(
          prompt,
        );
        third.toolRound([bash("delete", "rm docs/x.md")]);
        third.end();
        const fourth = await waitScript(chat.scripted, 4);
        expect(
          chat.app.knowledge.store.byId(chat.projectId, file.id),
        ).toBeNull();
        expect(
          chat.app.knowledge.versions(chat.projectId, file.id)[0],
        ).toMatchObject({ revision: 3, deleted: true, author });
        expect(fourth.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "delete",
          content: "exit 0\ndeleted docs/x.md",
        });
        expect(
          (fourth.body.messages as { content: string }[])[0]!.content,
        ).toBe(prompt);
        fourth.reply("done");
        if (origin === "automation") {
          const phase = await waitScript(chat.scripted, 5);
          expect(
            (phase.body.tools as { function: { name: string } }[]).map(
              (tool) => tool.function.name,
            ),
          ).toEqual(["memory_edit"]);
          phase.toolRound([bash("forbidden", "touch forbidden.md")]);
          phase.end();
          const recovery = await waitScript(chat.scripted, 6);
          expect(chat.app.knowledge.counts(chat.projectId).files).toBe(0);
          expect(recovery.body.messages).toContainEqual({
            role: "tool",
            tool_call_id: "forbidden",
            content: "Error: only memory_edit is offered in the memory phase.",
          });
          recovery.toolRound([
            { id: "none", name: "memory_edit", arguments: '{"action":"none"}' },
          ]);
          recovery.end();
        }
        expect((await settleRun(chat, sessionId))?.status).toBe("done");
        const markdown = await chat.member.call(
          "GET",
          `/api/sessions/${sessionId}/markdown?tz=UTC`,
        );
        expect(markdown.status).toBe(200);
        const text = await markdown.text();
        expect(text).not.toContain("docs/x.md");
        expect(text).not.toContain("exit 0");
      } finally {
        await chat.app.shutdown();
        chat.app.db.close();
      }
    },
  );

  test("a nonzero bash exit stays a failed tool row with its write receipt", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([
        {
          id: "failed",
          name: "bash",
          arguments: JSON.stringify({ command: "echo kept > kept.md; exit 1" }),
        },
      ]);
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      const row = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.toolCallId === "failed")!;
      expect(row.status).toBe("failed");
      expect(row.content).toBe("exit 1\nwrote kept.md (rev 1, 1 lines)");
      expect(
        chat.app.knowledge.store.byName(chat.projectId, "kept.md")?.text,
      ).toBe("kept\n");
      expect(answer.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "failed",
        content: row.content,
      });
      answer.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

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

  test("a Gemini call ending with stop runs and echoes its stored signature in the answer request", async () => {
    const recorded = await Bun.file(
      new URL("../fixtures/providers/gemini/chat-tools.sse", import.meta.url),
    ).text();
    const events = parseSse("", recorded).frames.flatMap(geminiEvents());
    const call = events.find((event) => event.kind === "toolCallDelta")!;
    expect(call.signature).toEqual(expect.any(String));
    expect(events.find((event) => event.kind === "finish")).toMatchObject({
      reason: "stop",
    });
    const chat = await chatApp({ wire: "gemini" });
    try {
      const { detail, script, sessionId } = await startChat(
        chat,
        "what time is it",
      );
      script.reasoning("<thought>check the clock");
      script.toolCall({
        id: call.id!,
        name: call.name!,
        arguments: call.arguments!,
        signature: call.signature,
      });
      script.finish("stop");
      script.usage();
      script.end();
      const next = await waitScript(chat.scripted, 2);
      const messages = next.body.messages as Record<string, unknown>[];
      expect(messages.find((message) => message.role === "assistant")).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
            extra_content: { google: { thought_signature: call.signature } },
          },
        ],
      });
      expect(messages.find((message) => message.role === "tool")).toMatchObject(
        {
          tool_call_id: call.id,
          content: expect.stringContaining('"timezone":"UTC"'),
        },
      );
      next.reply("It is noon.");
      await settle(chat);
      const rows = chat.app.sessions.messages(sessionId);
      expect(rows[1]).toMatchObject({
        slot: "work",
        status: "done",
        finishReason: "stop",
        reasoning: "check the clock",
        toolCalls: [
          {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            signature: call.signature,
          },
        ],
      });
      expect(rows[2]).toMatchObject({ kind: "tool", status: "done" });
      expect(rows[3]).toMatchObject({
        slot: "answer",
        round: 2,
        status: "done",
      });
      expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
        status: "done",
        cause: "finish",
        rounds: 2,
        toolCalls: 1,
        tokens: 30,
      });
      answerNodes(chat, sessionId);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
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

  test("websearch is not offered without a chosen provider", async () => {
    const chat = await chatApp({ secrets: {} });
    const { script } = await startChat(chat, "search");
    const tools = (script.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(tools).toContain("datetime");
    expect(tools).toContain("webfetch");
    expect(tools).not.toContain("websearch");
    script.reply("no search offered");
    await settle(chat);
    chat.app.socket.dispose();
  });

  test("the chosen search provider is snapshotted once per send", async () => {
    const chat = await chatApp({ secrets: { "search-exa": "exa-key" } });
    await chooseSearch(chat, "exa");
    const { script } = await startChat(chat, "search please");
    const offered = (script.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(offered).toContain("websearch");
    // the provider is unchosen now, but the send already holds its
    // snapshot; a fresh send, begun after, is offered no websearch
    const cleared = await chat.admin.call("PATCH", "/api/tools/websearch", {
      body: { provider: null },
    });
    expect(cleared.status).toBe(200);
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

  test("with a chosen provider websearch is offered", async () => {
    const chat = await chatApp({ secrets: { "search-exa": "exa-key" } });
    await chooseSearch(chat, "exa");
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
