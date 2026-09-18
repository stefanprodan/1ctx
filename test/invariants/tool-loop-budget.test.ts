// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { tokens } from "../../src/server/lib/tokens.ts";
import { wireTools } from "../../src/server/providers/index.ts";
import { EXHAUSTED_LINE } from "../../src/server/runner/context.ts";
import { buildRequest } from "../../src/server/runner/round.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import { chatApp, setLimits, startChat, waitScript } from "../helpers/chat.ts";

const time = (id: string) => ({
  id,
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
});

test("tool work counts final usage once, including cached tokens, and keeps the answer's length", async () => {
  const chat = await chatApp();
  try {
    await setLimits(chat, { toolWorkTokens: 10_000 });
    const { script, sessionId } = await startChat(chat);
    const send = chat.app.runner.registry.get(sessionId)!;
    script.toolRound([time("first")], { prompt: 4000, completion: 1000 });
    script.end();
    const second = await waitScript(chat.scripted, 2);
    expect(send.budget.tokens).toBe(5000);
    second.toolCall(time("crossing"));
    second.finish("tool_calls");
    second.usage({ prompt: 100, completion: 10 });
    second.sse(
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 4000,
          completion_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 3900 },
        },
      })}\n\n`,
    );
    second.end();
    const answer = await waitScript(chat.scripted, 3);
    expect(send.budget.tokens).toBe(10_000);
    expect(answer.body.tool_choice).toBe("none");
    expect(JSON.stringify(answer.body.messages)).toContain(EXHAUSTED_LINE);
    answer.content("The partial answer.");
    answer.finish("length");
    answer.usage({ prompt: 3000, completion: 1000 });
    answer.end();
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    expect(send.budget.tokens).toBe(14_000);
    const rows = chat.app.sessions.messages(sessionId);
    expect(
      rows.find((row) => row.round === 2 && row.kind === "reply"),
    ).toMatchObject({
      slot: "work",
      finishReason: "token_limit",
    });
    expect(rows.find((row) => row.toolCallId === "crossing")).toMatchObject({
      status: "stopped",
      content: "not run: the tool budget was spent",
    });
    expect(rows.at(-1)).toMatchObject({
      slot: "answer",
      finishReason: "length",
    });
    expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
      toolCalls: 1,
      tokens: 14_000,
    });
    const markdown = await chat.member.call(
      "GET",
      `/api/sessions/${sessionId}/markdown?tz=UTC`,
    );
    expect(await markdown.text()).toContain("max tokens");
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("rounds without usage accumulate the request estimate without fabricating usage rows", async () => {
  const chat = await chatApp({ window: 100_000 });
  try {
    await setLimits(chat, { toolWorkTokens: 10_000 });
    const { script, sessionId } = await startChat(chat, " budget".repeat(6000));
    const send = chat.app.runner.registry.get(sessionId)!;
    const estimate = () => {
      const req = buildRequest(
        send,
        chat.app.sessions.messages(sessionId),
        {
          usernameOf: (id) => chat.app.users.byId(id)?.username ?? null,
          reasoningDetailsOf: (id, providerId, model) =>
            chat.app.sessions.reasoningDetails(id, providerId, model),
        },
        chat.app.now.value,
      );
      return tokens(
        JSON.stringify({
          messages: req.messages,
          tools: wireTools(req.tools ?? []),
        }),
      );
    };
    const firstTokens = estimate();
    expect(firstTokens).toBeLessThan(10_000);
    script.toolCall(time("first"));
    script.finish("tool_calls");
    script.end();
    const second = await waitScript(chat.scripted, 2);
    expect(send.budget.tokens).toBe(firstTokens);
    const before = send.budget.tokens;
    const secondTokens = estimate();
    second.toolCall({
      ...time("second"),
      arguments: '{"timezone":"Europe/Paris"}',
    });
    second.finish("tool_calls");
    second.end();
    const answer = await waitScript(chat.scripted, 3);
    expect(send.budget.tokens).toBe(before + secondTokens);
    expect(send.budget.tokens).toBeGreaterThanOrEqual(10_000);
    expect(answer.body.tool_choice).toBe("none");
    expect(
      chat.app.sessions
        .messages(sessionId)
        .find((row) => row.round === 2 && row.kind === "reply")?.finishReason,
    ).toBe("token_limit");
    answer.reply("done");
    await settleRun(chat, sessionId);
    expect(chat.app.usage.forSession(sessionId)).toHaveLength(1);
    expect(chat.app.sessions.lastSend(sessionId)?.tokens).toBe(15);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test.each([
  { rounds: 2, toolWorkTokens: 10_000, expected: "tool_limit" },
  { rounds: 100, toolWorkTokens: 10_000, expected: "token_limit" },
  { rounds: 100, toolWorkTokens: 500_000, expected: "context_limit" },
] as const)(
  "crossing caps keep $expected on work and on disobedient answer calls",
  async (caps) => {
    const chat = await chatApp({ window: 20_000 });
    try {
      await setLimits(chat, {
        rounds: caps.rounds,
        toolWorkTokens: caps.toolWorkTokens,
      });
      const { script, sessionId } = await startChat(chat);
      script.toolRound([time("first")], { prompt: 14_000, completion: 1000 });
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      expect(answer.body.tool_choice).toBe("none");
      answer.toolRound([time("forbidden")]);
      answer.end();
      const bare = await waitScript(chat.scripted, 3);
      expect(bare.body.tools).toBeUndefined();
      bare.reply("answered");
      await settleRun(chat, sessionId);
      const rows = chat.app.sessions.messages(sessionId);
      expect(
        rows
          .filter((row) => row.kind === "reply")
          .map((row) => row.finishReason),
      ).toEqual([caps.expected, caps.expected, "stop"]);
      expect(
        rows
          .filter((row) => row.kind === "tool")
          .every((row) => row.status === "stopped"),
      ).toBe(true);
      expect(chat.scripted.requests.every((request) => request.accepted)).toBe(
        true,
      );
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  },
);

test("usage estimates count opaque call signatures carried into the next request", async () => {
  const chat = await chatApp({ wire: "gemini", window: 100_000 });
  try {
    await setLimits(chat, { toolWorkTokens: 10_000 });
    const { script, sessionId } = await startChat(chat);
    script.toolCall({ ...time("signed"), signature: " proof".repeat(10_000) });
    script.finish("stop");
    script.end();
    const second = await waitScript(chat.scripted, 2);
    expect(chat.scripted.requests[1]!.inputTokens).toBeGreaterThan(10_000);
    second.toolCall({
      ...time("not-run"),
      arguments: '{"timezone":"Europe/Paris"}',
    });
    second.finish("stop");
    second.end();
    const answer = await waitScript(chat.scripted, 3);
    expect(answer.body.tool_choice).toBe("none");
    expect(
      chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "reply" && row.round === 2)?.finishReason,
    ).toBe("token_limit");
    answer.reply("done");
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    expect(chat.app.usage.forSession(sessionId)).toHaveLength(1);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("an exhausted main budget does not block the own-memory phase or count its tokens", async () => {
  const chat = await chatApp();
  try {
    await setLimits(chat, { toolWorkTokens: 10_000 });
    const automation = await createAutomation(chat, { ownMemory: true });
    const { main, sessionId } = await startRun(chat, automation.id);
    const send = chat.app.runner.registry.get(sessionId)!;
    main.toolRound([time("first")], { prompt: 10_000, completion: 0 });
    main.end();
    (await waitScript(chat.scripted, 2)).reply("done");
    const phase = await waitScript(chat.scripted, 3);
    expect(send.budget.tokens).toBe(10_015);
    expect(phase.body.tools).toMatchObject([
      { function: { name: "memory_edit" } },
    ]);
    phase.toolRound(
      [{ id: "none", name: "memory_edit", arguments: '{"action":"none"}' }],
      { prompt: 2000, completion: 100 },
    );
    phase.end();
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    expect(send.budget.tokens).toBe(10_015);
    expect(chat.app.sessions.lastSend(sessionId)?.tokens).toBe(12_115);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});
