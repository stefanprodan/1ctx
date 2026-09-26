// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import { LOOP_LIMITS } from "../../src/server/runner/limits.ts";
import { HTML_EVERY_MS } from "../../src/server/runner/stream.ts";
import { settleRun } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
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
    // lowered caps: round 1's cut results pass the send's result bytes,
    // so round 2's calls are recorded not run and the answer round
    // follows
    const resultCut = 10_000;
    const resultBytes = 65_536;
    const perRound = LOOP_LIMITS.callsPerRound;
    expect(resultCut * perRound).toBeGreaterThanOrEqual(resultBytes);
    const big = "x".repeat(resultCut + 5000);
    const plans: Record<string, ToolPlan> = {};
    for (let r = 1; r <= 2; r++) {
      for (let i = 0; i < perRound; i++) {
        plans[`r${r}c${i}`] = { result: { content: big, error: false } };
      }
    }
    const fake = fakeTools(plans);
    const chat = await chatApp(fake);
    await setLimits(chat, { resultBytes, resultCut });
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "big results");
    watch(chat, conn, sessionId);
    const calls = (round: number) =>
      Array.from({ length: perRound }, (_, i) =>
        call(`r${round}c${i}`, {
          timezone: `Etc/GMT+${((round * 7 + i) % 12) + 1}`,
        }),
      );
    for (let round = 1; round <= 2; round++) {
      const script = await waitScript(chat.scripted, round);
      expect(asksAnswer(script.body)).toBe(false);
      toolRound(script, calls(round));
    }
    const answer = await waitScript(chat.scripted, 3);
    expect(asksAnswer(answer.body)).toBe(true);
    answer.reply("done after the cap");
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    await settle(chat, 10);
    record("cap-result", detail, conn);
    const tools = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(2 * perRound);
    for (const row of tools.slice(0, perRound)) {
      expect(row.status).toBe("done");
      expect(row.content.length).toBe(resultCut);
    }
    for (const row of tools.slice(perRound)) expect(row.status).toBe("stopped");
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.at(-2)!.finishReason).toBe("tool_limit");
    expect(replies.at(-1)!.content).toBe("done after the cap");
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(3);
    chat.app.socket.dispose();
  });

  test("the result cap with a provider that keeps calling", async () => {
    // every request after the cap still answers with calls, so the
    // send ends on work rows whose calls were recorded not run and no
    // answer row
    const resultCut = 10_000;
    const resultBytes = 65_536;
    const perRound = LOOP_LIMITS.callsPerRound;
    const big = "x".repeat(resultCut + 5000);
    const plans: Record<string, ToolPlan> = {};
    for (let r = 1; r <= LOOP_LIMITS.rounds; r++) {
      for (let i = 0; i < perRound; i++) {
        plans[`r${r}c${i}`] = { result: { content: big, error: false } };
      }
    }
    const chat = await chatApp(fakeTools(plans));
    await setLimits(chat, { resultBytes, resultCut });
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "keeps calling");
    watch(chat, conn, sessionId);
    let requests = 0;
    for (let round = 1; round <= LOOP_LIMITS.rounds; round++) {
      if (chat.app.sessions.send(detail.send.id)!.status !== "running") break;
      const script = await waitScript(chat.scripted, round);
      requests = round;
      toolRound(
        script,
        Array.from({ length: perRound }, (_, i) =>
          call(`r${round}c${i}`, {
            timezone: `Etc/GMT+${((round * 7 + i) % 12) + 1}`,
          }),
        ),
      );
      await settle(chat, 8);
    }
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    await settle(chat, 10);
    record("cap-result-calling", detail, conn);
    const rows = chat.app.sessions.messages(sessionId);
    const replies = rows.filter((r) => r.kind === "reply");
    expect(replies.every((r) => r.slot === "work")).toBe(true);
    for (const reply of replies.slice(1)) {
      expect(reply.finishReason).toBe("tool_limit");
    }
    const tools = rows.filter((r) => r.kind === "tool");
    for (const row of tools.slice(0, perRound)) {
      expect(row.status).toBe("done");
      expect(row.content.length).toBe(resultCut);
    }
    const stopped = tools.slice(perRound);
    expect(stopped.length).toBeGreaterThan(0);
    for (const row of stopped) expect(row.status).toBe("stopped");
    expect(chat.app.sessions.send(detail.send.id)!.rounds).toBe(requests);
    chat.app.socket.dispose();
  });

  test("the loop check", async () => {
    const fake = fakeTools({});
    const chat = await chatApp(fake);
    const conn = await watcher(chat);
    const { detail, sessionId } = await startChat(chat, "loop");
    watch(chat, conn, sessionId);
    for (let round = 1; round <= 6; round++) {
      const script = await waitScript(chat.scripted, round);
      toolRound(script, [call("same")]);
    }
    const answer = await waitScript(chat.scripted, 7);
    // the answer streams past the html interval, so the recording
    // carries an html frame between its deltas
    chat.app.now.value += HTML_EVERY_MS;
    answer.reply("answered after the loop");
    await settle(chat, 10);
    expect(conn.frames.some((f) => f.type === "html")).toBe(true);
    record("loop-check", detail, conn);
    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((r) => r.kind === "reply");
    expect(replies.at(-2)!.finishReason).toBe("tool_loop");
    expect(replies.at(-1)!.content).toBe("answered after the loop");
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
