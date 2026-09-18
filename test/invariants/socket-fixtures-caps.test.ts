// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import { TOOL_CAPS } from "../../src/server/tools/index.ts";
import { settleRun } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  waitScript,
} from "../helpers/chat.ts";
import {
  call,
  fakeTools,
  record,
  settle,
  type ToolPlan,
  toolRound,
  watch,
  watcher,
} from "../helpers/socket-fixtures.ts";
import { asksAnswer } from "../helpers/tool-loop.ts";

describe("socket fixtures for caps", () => {
  test("the round cap", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const rounds = 10;
    expect(
      (
        await chat.admin.call("PUT", "/api/limits", {
          body: { values: { ...DEFAULT_LIMITS, rounds } },
        })
      ).status,
    ).toBe(200);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "many rounds");
    watch(chat, conn, sessionId);
    for (let round = 1; round <= rounds; round++) {
      const script = await waitScript(chat.scripted, round);
      if (round === rounds) {
        expect(asksAnswer(script.body)).toBe(true);
        script.reply("done after the cap");
      } else {
        toolRound(script, [
          call(`r${round}`, { timezone: `Etc/GMT+${(round % 12) + 1}` }),
        ]);
      }
    }
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    record("cap-rounds", detail, conn);
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(rounds);
    chat.app.socket.dispose();
  });

  test("the call cap", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(
      chat,
      "too many at once",
    );
    watch(chat, conn, sessionId);
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      call(`c${i}`, { timezone: `Etc/GMT+${(i % 12) + 1}` }),
    );
    toolRound(script, many);
    const r2 = await chat.scripted.next();
    r2.reply("answered without the tools");
    await settle(chat, 10);
    record("cap-calls", detail, conn);
    const toolRows = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "tool");
    expect(toolRows.every((r) => r.status === "stopped")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the time cap", async () => {
    const holder: { chat: ChatApp | null } = { chat: null };
    const fake = fakeTools({
      c1: {
        result: { content: "slow", error: false },
        onRun: () => {
          if (holder.chat)
            holder.chat.app.now.value += LOOP_LIMITS.toolMs + 1000;
        },
      },
    });
    const chat = await chatApp(fake);
    holder.chat = chat;
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "long tools");
    watch(chat, conn, sessionId);
    toolRound(script, [call("c1")]);
    const r2 = await waitScript(chat.scripted, 2);
    toolRound(r2, [call("c2")]);
    const r3 = await waitScript(chat.scripted, 3);
    r3.reply("out of time for tools");
    await settle(chat, 12);
    record("cap-time", detail, conn);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.some((r) => r.finishReason === "tool_limit")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the result cap with a cut result", async () => {
    const big = "x".repeat(TOOL_CAPS.resultCut + 5000);
    const plans: Record<string, ToolPlan> = {};
    for (let r = 1; r <= LOOP_LIMITS.rounds; r++) {
      for (let i = 0; i < LOOP_LIMITS.callsPerRound; i++) {
        plans[`r${r}c${i}`] = { result: { content: big, error: false } };
      }
    }
    const fake = fakeTools(plans);
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "big results");
    watch(chat, conn, sessionId);
    for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
      const send = chat.app.sessions.send(detail.send.id)!;
      if (send.status !== "running") break;
      const script = await waitScript(chat.scripted, round);
      const calls = Array.from({ length: LOOP_LIMITS.callsPerRound }, (_, i) =>
        call(`r${round}c${i}`, {
          timezone: `Etc/GMT+${((round * 7 + i) % 12) + 1}`,
        }),
      );
      toolRound(script, calls);
      await settle(chat, 8);
    }
    await settle(chat, 10);
    record("cap-result", detail, conn);
    const toolRow = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "tool")!;
    expect(toolRow.content.length).toBe(TOOL_CAPS.resultCut);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.some((r) => r.finishReason === "tool_limit")).toBe(true);
    chat.app.socket.dispose();
  });

  test("the loop check", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "loop");
    watch(chat, conn, sessionId);
    for (let round = 1; round <= 3; round++) {
      const script = await waitScript(chat.scripted, round);
      toolRound(script, [call("same")]);
      await settle(chat, 6);
    }
    await settle(chat, 10);
    record("loop-check", detail, conn);
    const lastReply = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply")
      .at(-1)!;
    expect(lastReply.finishReason).toBe("tool_loop");
    chat.app.socket.dispose();
  });

  test("calls in the answer round", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "answer calls");
    watch(chat, conn, sessionId);
    const many = Array.from({ length: LOOP_LIMITS.callsPerRound + 1 }, (_, i) =>
      call(`c${i}`, { timezone: `Etc/GMT+${(i % 12) + 1}` }),
    );
    toolRound(script, many);
    const answer = await chat.scripted.next();
    toolRound(answer, [call("again")]);
    const bare = await chat.scripted.next();
    bare.reply("answered without tools");
    await settle(chat, 12);
    record("calls-in-answer-round", detail, conn);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.map((r) => r.finishReason)).toEqual([
      "tool_limit",
      "tool_limit",
      "stop",
    ]);
    chat.app.socket.dispose();
  });

  test("a cut round with partial calls", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, script, sessionId } = await startChat(chat, "cut round");
    watch(chat, conn, sessionId);
    script.toolCall(call("c1"));
    script.finish("length");
    script.usage();
    script.end();
    await settle(chat, 8);
    record("cut-round", detail, conn);
    const reply = chat.app.sessions
      .messages(sessionId)
      .find((r) => r.kind === "reply")!;
    expect(reply.finishReason).toBe("length");
    chat.app.socket.dispose();
  });
});
