// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The opencode wire: the body OpenCode sends to Go, with no thinking
// flag and no cache key in it, the requested model's past reasoning
// back as reasoning_content, Off as reasoning_effort none, and the
// session headers that route a chat to its cache, sent only with a
// cache key.

import { describe, expect, test } from "bun:test";
import {
  buildOpenCodeChatBody as buildChatBody,
  type ChatEvent,
  type ChatRequest,
  type ProviderRow,
  parseCatalog,
  requestTokens,
} from "../../../src/server/providers/index.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import { EFFORTS, isEffort, isWire } from "../../../src/shared/words.ts";
import { fakeFetch, PROVIDER_URL } from "../../helpers/app.ts";

const KEY = "sk-opencode-test-key-that-must-not-leak";
const row: ProviderRow = {
  id: "oc1",
  name: "opencode",
  wire: "opencode",
  baseUrl: `${PROVIDER_URL}/`,
  keyName: "provider-opencode",
  createdAt: 0,
};
const request: ChatRequest = {
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "what time is it", name: "ana" },
    {
      role: "assistant",
      model: "deepseek-v4.1-flash",
      content: "",
      reasoning: "check the clock",
      reasoningDetails: [{ type: "reasoning.text", text: "check the clock" }],
      toolCalls: [{ id: "call_1", name: "datetime", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call_1", content: "noon" },
  ],
  thinking: true,
  reasoningEffort: "max",
  cacheKey: "session-1",
  tools: [{ name: "datetime", description: "the clock", parameters: {} }],
};

async function sent(req: ChatRequest) {
  const fake = fakeFetch();
  const provider = providerFor(row, {
    fetcher: fake.fetcher,
    secret: () => KEY,
  });
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(req, new AbortController().signal)) {
    events.push(event);
  }
  expect(fake.calls).toHaveLength(1);
  return { call: fake.calls[0]!, events };
}

describe("the opencode wire", () => {
  test("is a wire whose levels add max", () => {
    expect(isWire("opencode")).toBe(true);
    expect(EFFORTS.opencode).toEqual(["low", "medium", "high", "max"]);
    expect(isEffort("opencode", "minimal")).toBe(false);
    expect(isEffort("opencode", "xhigh")).toBe(false);
    for (const wire of ["openrouter", "openai-strict", "gemini"] as const) {
      expect(isEffort(wire, "max")).toBe(false);
    }
  });

  test("a catalog of ids alone leaves every model undescribed", () => {
    const models = parseCatalog({
      object: "list",
      data: [
        {
          id: "deepseek-v4.1-flash",
          object: "model",
          created: 0,
          owned_by: "opencode",
        },
      ],
    });
    expect(models).toEqual([
      {
        id: "deepseek-v4.1-flash",
        name: "deepseek-v4.1-flash",
        contextLength: null,
        promptPrice: null,
        completionPrice: null,
        tools: false,
        reasoning: false,
        thinkingRequired: false,
        reasoningKnown: false,
        described: false,
      },
    ]);
  });
});

describe("opencode chat body", () => {
  test("carries no thinking flag, cache key or host filter", () => {
    const body = buildChatBody({ ...request, skip4Bit: true });
    expect(Object.keys(body).sort()).toEqual([
      "messages",
      "model",
      "reasoning_effort",
      "stream",
      "stream_options",
      "tools",
    ]);
    expect(body.reasoning_effort).toBe("max");
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("sends the model's own past reasoning as reasoning_content, never the details", () => {
    const messages = buildChatBody(request).messages as Record<
      string,
      unknown
    >[];
    expect(messages[2]).toEqual({
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
    // the request is the caller's and stays as it was
    expect(request.messages[2]).toHaveProperty("reasoningDetails");
  });

  test("sends no reasoning that is empty, another model's or unattributed", () => {
    const body = buildChatBody({
      ...request,
      messages: [
        { role: "assistant", model: request.model, content: "a" },
        {
          role: "assistant",
          model: request.model,
          content: "b",
          reasoning: "",
        },
        { role: "assistant", model: "kimi-k2.6", content: "c", reasoning: "x" },
        { role: "assistant", content: "d", reasoning: "y" },
      ],
    });
    expect(body.messages).toEqual(
      ["a", "b", "c", "d"].map((content) => ({ role: "assistant", content })),
    );
  });

  test("turns thinking off as none only on the agent's own Off", () => {
    const off = { ...request, thinking: false, reasoningEffort: null };
    expect(buildChatBody({ ...off, thinkingOff: true }).reasoning_effort).toBe(
      "none",
    );
    expect(buildChatBody(off)).not.toHaveProperty("reasoning_effort");
    expect(
      buildChatBody({ ...request, reasoningEffort: null }),
    ).not.toHaveProperty("reasoning_effort");
  });

  test("sends temperature, top_p and a summary's cap only when set", () => {
    const body = buildChatBody({
      ...request,
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 300,
    });
    expect(body).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 300,
    });
  });
});

describe("opencode request tokens", () => {
  test("count the past reasoning only where the wire sends it", () => {
    const thought = "a long chain of thought ".repeat(50);
    const req = (model: string): ChatRequest => ({
      ...request,
      messages: [
        { role: "assistant", model, content: "hi", reasoning: thought },
      ],
    });
    const plainOf = (model: string) =>
      requestTokens("opencode", {
        ...request,
        messages: [{ role: "assistant", model, content: "hi" }],
      });
    const own = req(request.model);
    const plain = plainOf(request.model);
    expect(requestTokens("opencode", own)).toBeGreaterThan(plain + 100);
    // another model's reasoning is not sent, so it is not counted
    expect(requestTokens("opencode", req("kimi-k2.6"))).toBe(
      plainOf("kimi-k2.6"),
    );
    for (const wire of ["openai-compatible", "openai-strict", null] as const) {
      expect(requestTokens(wire, own)).toBe(plain);
    }
  });
});

describe("opencode request", () => {
  test("names the chat in the four session headers", async () => {
    const { call, events } = await sent(request);
    expect(call.url).toBe(`${PROVIDER_URL}/chat/completions`);
    expect(call.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-opencode-session": "session-1",
      "x-opencode-session-id": "session-1",
      "x-session-affinity": "session-1",
      "x-session-id": "session-1",
    });
    const body = JSON.parse(call.body!);
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(events.map((e) => e.kind)).not.toContain("error");
  });

  test("sends no session header without a cache key", async () => {
    for (const cacheKey of [null, undefined, ""]) {
      const { call } = await sent({ ...request, cacheKey });
      expect(call.headers).toEqual({
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      });
    }
  });
});
