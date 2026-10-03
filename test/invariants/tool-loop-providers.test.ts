// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { geminiEvents } from "../../src/server/providers/index.ts";
import { parseSse } from "../../src/server/providers/openai.ts";
import type { Wire } from "../../src/shared/words.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  NO_TOOLS,
  startChat,
  waitScript,
} from "../helpers/chat.ts";
import { answerNodes, settle, shape } from "../helpers/tool-loop.ts";

async function chooseSearch(chat: ChatApp, provider: "exa" | "firecrawl") {
  const res = await chat.admin.call("PATCH", "/api/tools/websearch", {
    body: { provider },
  });
  expect(res.status).toBe(200);
}

describe("tool loop provider policy", () => {
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

  test("a strict tool round sends only spec fields", async () => {
    const chat = await chatApp({ wire: "openai-strict" });
    try {
      const { detail, script } = await startChat(chat, "what time is it");
      for (const field of [
        "enable_thinking",
        "chat_template_kwargs",
        "prompt_cache_key",
      ]) {
        expect(script.body).not.toHaveProperty(field);
      }
      // the model reasons by its catalog flag, so thinking is on and no
      // effort is sent: the provider's default
      expect(script.body).not.toHaveProperty("reasoning_effort");
      script.reasoning("check the clock");
      script.toolCall({ id: "call_1", name: "datetime", arguments: "{}" });
      script.finish("tool_calls");
      script.usage();
      script.end();
      const next = await waitScript(chat.scripted, 2);
      const messages = next.body.messages as Record<string, unknown>[];
      expect(messages.find((message) => message.role === "assistant")).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "datetime", arguments: "{}" },
          },
        ],
      });
      expect(next.body).not.toHaveProperty("prompt_cache_key");
      next.reply("It is noon.");
      await settle(chat);
      expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
        status: "done",
        cause: "finish",
        rounds: 2,
        toolCalls: 1,
      });
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("an opencode tool round routes by the session headers and sends its reasoning back", async () => {
    const chat = await chatApp({ wire: "opencode" });
    try {
      const { detail, script, sessionId } = await startChat(
        chat,
        "what time is it",
      );
      expect(script.body).not.toHaveProperty("enable_thinking");
      expect(script.body).not.toHaveProperty("prompt_cache_key");
      const session = {
        "x-opencode-session": sessionId,
        "x-opencode-session-id": sessionId,
        "x-session-affinity": sessionId,
        "x-session-id": sessionId,
      };
      expect(script.headers).toMatchObject(session);
      expect(script.headers["user-agent"]).toStartWith("1ctx/");
      script.reasoning("check the clock");
      script.toolCall({ id: "call_1", name: "datetime", arguments: "{}" });
      script.finish("tool_calls");
      script.usage();
      script.end();
      const next = await waitScript(chat.scripted, 2);
      expect(next.headers).toMatchObject(session);
      const messages = next.body.messages as Record<string, unknown>[];
      expect(messages.find((message) => message.role === "assistant")).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "datetime", arguments: "{}" },
          },
        ],
        reasoning_content: "check the clock",
      });
      next.reply("It is noon.");
      await settle(chat);
      expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
        status: "done",
        cause: "finish",
        rounds: 2,
        toolCalls: 1,
      });
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  // a turn with reasoning, then a second turn: what the second request
  // carries on the first turn's assistant message
  async function secondTurn(
    wire: Wire,
    reasoning: string,
    nextModel?: string,
  ): Promise<{ model: unknown; assistant: Record<string, unknown> }> {
    const chat = await chatApp({ wire });
    try {
      const { script, sessionId } = await startChat(chat, "hello");
      if (reasoning !== "") script.reasoning(reasoning);
      script.reply("hi there");
      await settle(chat);
      if (nextModel !== undefined) {
        chat.app.db
          .query("update agents set model = ? where id = ?")
          .run(nextModel, chat.agentId);
      }
      const pending = chat.scripted.next();
      const res = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/messages`,
        { body: { message: "and again" } },
      );
      expect(res.status).toBeLessThan(300);
      const next = await pending;
      next.reply("done");
      await settle(chat);
      const messages = next.body.messages as Record<string, unknown>[];
      return {
        model: next.body.model,
        assistant: messages.find((message) => message.role === "assistant")!,
      };
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  }

  test("opencode sends the same model's reasoning back on a later turn", async () => {
    expect(await secondTurn("opencode", "greet first")).toEqual({
      model: FLASH,
      assistant: {
        role: "assistant",
        content: "hi there",
        reasoning_content: "greet first",
      },
    });
  });

  test("opencode sends no reasoning another model wrote, and none that is empty", async () => {
    const other = "z-ai/glm-5.3-flash";
    expect(await secondTurn("opencode", "greet first", other)).toEqual({
      model: other,
      assistant: { role: "assistant", content: "hi there" },
    });
    expect((await secondTurn("opencode", "")).assistant).toEqual({
      role: "assistant",
      content: "hi there",
    });
  });

  test("no other wire sends past reasoning back", async () => {
    for (const wire of ["openai-compatible", "openai-strict"] as const) {
      expect((await secondTurn(wire, "greet first")).assistant).toEqual({
        role: "assistant",
        content: "hi there",
      });
    }
    // DeepSeek on OpenRouter gets its empty field, as before
    expect((await secondTurn("openrouter", "greet first")).assistant).toEqual({
      role: "assistant",
      content: "hi there",
      reasoning: "",
    });
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
    // The active send keeps its snapshot even after the provider is cleared.
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
});
