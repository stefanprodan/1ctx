// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { tokens } from "../../src/server/lib/tokens.ts";
import { EXHAUSTED_LINE, SUMMARIZE } from "../../src/server/runner/context.ts";
import { CONTEXT_CUT } from "../../src/server/runner/results.ts";
import { PROVIDER_URL } from "../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import {
  chatApp,
  scriptedFetch,
  setLimits,
  startChat,
  tick,
  waitScript,
} from "../helpers/chat.ts";
import { asksAnswer } from "../helpers/tool-loop.ts";

const time = (id: string) => ({
  id,
  name: "datetime",
  arguments: '{"timezone":"UTC"}',
});

test("the strict provider counts requests and refuses input plus max_tokens over its window", async () => {
  const scripted = scriptedFetch(undefined, 1000);
  const body = {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1000,
  };
  const response = await scripted.fetcher(`${PROVIDER_URL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("input plus max_tokens");
  expect(scripted.requests).toEqual([
    {
      inputTokens: tokens(
        JSON.stringify({ messages: body.messages, tools: [] }),
      ),
      maxTokens: 1000,
      accepted: false,
    },
  ]);
  expect(scripted.scripts).toHaveLength(0);
});

test.each(["chat", "automation"] as const)(
  "the %s window threshold forces an accepted answer before calls",
  async (origin) => {
    const chat = await chatApp({ window: 20_000 });
    try {
      const started =
        origin === "chat"
          ? await startChat(chat)
          : await startRun(chat, (await createAutomation(chat)).id).then(
              ({ sessionId, main }) => ({ sessionId, script: main }),
            );
      const { script, sessionId } = started;
      script.toolRound([time("not-run")], { prompt: 14_000, completion: 1000 });
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      expect(asksAnswer(answer.body)).toBe(true);
      expect(answer.body.tools).toEqual(script.body.tools);
      expect(JSON.stringify(answer.body.messages)).toContain(EXHAUSTED_LINE);
      expect(chat.app.sessions.messages(sessionId)[1]).toMatchObject({
        slot: "work",
        finishReason: "context_limit",
      });
      expect(chat.app.sessions.messages(sessionId)[2]).toMatchObject({
        status: "stopped",
        content: "not run: the tool budget was spent",
      });
      answer.content("The answer.");
      answer.finish();
      answer.usage({ prompt: 15_000, completion: 100 });
      answer.end();
      if (origin === "chat") {
        const summary = await waitScript(chat.scripted, 3);
        summary.reply("## Goal\nKeep the answer.");
      }
      expect((await settleRun(chat, sessionId))?.status).toBe("done");
      expect(chat.scripted.requests.every((request) => request.accepted)).toBe(
        true,
      );
      expect(chat.scripted.scripts).toHaveLength(origin === "chat" ? 3 : 2);
      expect(
        chat.app.sessions
          .messages(sessionId)
          .filter((row) => row.kind === "summary"),
      ).toHaveLength(origin === "chat" ? 1 : 0);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  },
);

test("a round without usage weighs its request estimate against the window", async () => {
  const chat = await chatApp({ window: 20_000 });
  try {
    const { script, sessionId } = await startChat(
      chat,
      " window".repeat(15_000),
    );
    const input = chat.scripted.requests[0]!.inputTokens;
    expect(input).toBeGreaterThanOrEqual(15_000);
    expect(input).toBeLessThan(20_000);
    script.toolCall(time("not-run"));
    script.finish("tool_calls");
    script.end();
    const answer = await waitScript(chat.scripted, 2);
    expect(asksAnswer(answer.body)).toBe(true);
    expect(chat.app.sessions.messages(sessionId)[1]?.finishReason).toBe(
      "context_limit",
    );
    answer.reply("done");
    await settleRun(chat, sessionId);
    expect(chat.scripted.requests.every((request) => request.accepted)).toBe(
      true,
    );
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("an unknown window leaves calls and results alone", async () => {
  const chat = await chatApp();
  try {
    chat.app.db
      .query("update agents set context_length = null where id = ?")
      .run(chat.agentId);
    await setLimits(chat, { toolWorkTokens: 10_000_000 });
    const { script, sessionId } = await startChat(chat);
    script.toolRound([time("runs")], { prompt: 2_000_000, completion: 1 });
    script.end();
    const answer = await waitScript(chat.scripted, 2);
    expect(answer.body.tool_choice).toBeUndefined();
    expect(chat.app.sessions.messages(sessionId)[2]).toMatchObject({
      status: "done",
    });
    answer.reply("done");
    await settleRun(chat, sessionId);
    expect(chat.scripted.scripts).toHaveLength(2);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("protected receipts that cannot fit are stored before the send fails explicitly", async () => {
  const chat = await chatApp({ window: 20_000 });
  try {
    const { script, sessionId } = await startChat(chat);
    script.toolRound(
      [
        {
          id: "write",
          name: "bash",
          arguments: JSON.stringify({ command: "echo saved > kept.md" }),
        },
      ],
      { prompt: 14_999, completion: 0 },
    );
    script.end();
    expect((await settleRun(chat, sessionId))?.status).toBe("failed");
    expect(chat.app.sessions.lastSend(sessionId)?.error).toBe(
      "the result tails do not fit the context",
    );
    expect(
      chat.app.sessions.messages(sessionId).find((row) => row.kind === "tool"),
    ).toMatchObject({
      status: "done",
      content: "exit 0\nwrote kept.md (rev 1, 1 lines)",
    });
    expect(
      chat.app.knowledge.store.byName(chat.projectId, "kept.md")?.text,
    ).toBe("saved\n");
    expect(chat.scripted.scripts).toHaveLength(1);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("stopping a buffered round settles its calls without writing late results", async () => {
  const started: string[] = [];
  let aborted = false;
  const chat = await chatApp({
    window: 20_000,
    tools: {
      capabilities: () => [],
      serverNames: () => [],
      offered: () => ({
        tools: [{ name: "datetime", description: "time", parameters: {} }],
        search: null,
        skills: { block: "", skills: [] },
        mcp: [],
        mcpPrompt: { text: "", digest: {} },
        mcpCatalog: "",
        memory: null,
        web: null,
      }),
      run: async (_offered, call, ctx) => {
        started.push(call.id);
        if (call.id === "first")
          return { content: "a completed result", error: false };
        return new Promise((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({ content: "a late result", error: false });
            },
            { once: true },
          );
        });
      },
    },
  });
  try {
    const { script, sessionId } = await startChat(chat);
    script.toolRound([time("first"), time("second")], {
      prompt: 10_000,
      completion: 100,
    });
    script.end();
    for (let i = 0; i < 200 && started.length < 2; i++) await tick();
    expect(started).toEqual(["first", "second"]);
    expect(
      chat.app.sessions
        .messages(sessionId)
        .filter((row) => row.kind === "tool")
        .map((row) => row.status),
    ).toEqual(["streaming", "streaming"]);
    expect(
      (await chat.member.call("POST", `/api/sessions/${sessionId}/stop`))
        .status,
    ).toBe(200);
    await settleRun(chat, sessionId);
    expect(aborted).toBe(true);
    expect(
      chat.app.sessions
        .messages(sessionId)
        .filter((row) => row.kind === "tool")
        .map((row) => ({ status: row.status, content: row.content })),
    ).toEqual([
      { status: "stopped", content: "stopped before it finished" },
      { status: "stopped", content: "stopped before it finished" },
    ]);
    expect(chat.scripted.scripts).toHaveLength(1);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
});

test("oversized round results are stored cut with bash tails and the answer and summary both fit", async () => {
  const chat = await chatApp({ window: 40_000 });
  try {
    const { script, sessionId } = await startChat(chat);
    const send = chat.app.runner.registry.get(sessionId)!;
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `read-${index}`,
      name: "bash",
      arguments: JSON.stringify({
        command: `seq ${index + 1} ${10_000 + index}; echo saved > doc-${index}.md${index === 0 ? "; exit 1" : ""}`,
      }),
    }));
    script.toolRound(calls, {
      prompt: chat.scripted.requests[0]!.inputTokens,
      completion: 2000,
    });
    script.end();
    const answer = await waitScript(chat.scripted, 2);
    expect(asksAnswer(answer.body)).toBe(true);
    const stored = chat.app.sessions.messages(sessionId);
    expect(stored[1]).toMatchObject({
      slot: "work",
      finishReason: "context_limit",
    });
    const results = stored.filter((row) => row.kind === "tool");
    expect(results).toHaveLength(10);
    expect(
      results.filter((row) => row.content.endsWith(CONTEXT_CUT)).length,
    ).toBeGreaterThan(0);
    expect(results[0]?.status).toBe("failed");
    for (const [index, result] of results.entries()) {
      expect(result.content).toContain(
        `exit ${index === 0 ? 1 : 0}\nwrote doc-${index}.md (rev 1, 1 lines)`,
      );
      expect(
        chat.app.knowledge.store.byName(chat.projectId, `doc-${index}.md`)
          ?.text,
      ).toBe("saved\n");
      expect(
        (
          answer.body.messages as {
            role: string;
            tool_call_id?: string;
            content: string;
          }[]
        ).find((message) => message.tool_call_id === calls[index]!.id)?.content,
      ).toBe(result.content + (index === 9 ? `\n\n${EXHAUSTED_LINE}` : ""));
    }
    expect(send.budget.resultBytes).toBe(
      results.reduce(
        (sum, result) =>
          sum + new TextEncoder().encode(result.content).byteLength,
        0,
      ),
    );
    const beforeAnswer = send.budget.tokens;
    answer.content("The files are saved.");
    answer.finish("length");
    answer.usage({ prompt: 30_000, completion: 500 });
    answer.end();
    const summary = await waitScript(chat.scripted, 3);
    expect(summary.body.messages).toContainEqual({
      role: "user",
      content: SUMMARIZE,
    });
    for (const [index, result] of results.entries()) {
      expect(summary.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: calls[index]!.id,
        content: result.content,
      });
    }
    expect(send.budget.tokens).toBe(beforeAnswer + 30_500);
    summary.content("## Goal\nFiles are saved.");
    summary.finish();
    summary.usage({ prompt: 30_000, completion: 200 });
    summary.end();
    expect((await settleRun(chat, sessionId))?.status).toBe("done");
    expect(send.budget.tokens).toBe(beforeAnswer + 30_500);
    expect(chat.app.sessions.lastSend(sessionId)?.tokens).toBe(
      send.budget.tokens + 30_200,
    );
    const answerRow = chat.app.sessions
      .messages(sessionId)
      .find((row) => row.slot === "answer")!;
    expect(answerRow.finishReason).toBe("length");
    expect(chat.scripted.requests).toHaveLength(3);
    for (const request of chat.scripted.requests) {
      expect(request.accepted).toBe(true);
      expect(request.inputTokens + request.maxTokens).toBeLessThanOrEqual(
        40_000,
      );
    }
    const fork = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/fork`,
      {
        body: { agentId: chat.agentId, messageId: answerRow.id },
      },
    );
    expect(fork.status).toBe(201);
    const detail = await fork.json();
    expect(
      chat.app.sessions
        .messages(detail.session.id)
        .some((row) => row.finishReason === "context_limit"),
    ).toBe(true);
  } finally {
    await chat.app.shutdown();
    chat.app.db.close();
  }
}, 20_000);
