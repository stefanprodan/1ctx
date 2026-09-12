// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenRouter wire over the frames recorded from the live API on
// 2026-09-10 (test/fixtures/providers/openrouter/): the body rules, a
// tool-calling stream, a plain stream with reasoning and a refused
// request, through a provider row of the openrouter wire.

import { describe, expect, test } from "bun:test";
import {
  buildChatBody,
  errorText,
  mergeReasoningDetail,
  takesCacheBreakpoints,
  withCacheBreakpoints,
  withEmptyReasoning,
} from "../../../src/server/providers/openrouter.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import type { ProviderRow } from "../../../src/server/providers/store.ts";
import type {
  ChatEvent,
  ChatRequest,
} from "../../../src/server/providers/types.ts";

const fixture = (name: string) =>
  Bun.file(
    new URL(`../../fixtures/providers/openrouter/${name}`, import.meta.url),
  );
const toolsStream = await fixture("chat-tools.sse").text();
const plainStream = await fixture("chat-stream.sse").text();
const refused = await fixture("error-429.json").text();

const KEY = "sk-or-v1-test-key-that-must-never-leak";
const FREE = "nvidia/nemotron-3-super-120b-a12b:free";

const row: ProviderRow = {
  id: "p1",
  name: "router",
  wire: "openrouter",
  baseUrl: "http://router.test/api/v1/",
  keyName: "router",
  createdAt: 0,
};

const request: ChatRequest = {
  model: FREE,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", reasoning: "greet back" },
    { role: "user", content: "what time is it?" },
  ],
  thinking: true,
  reasoningEffort: null,
  temperature: 0.7,
  topP: null,
  maxTokens: 300,
  cacheKey: "session-1",
  tools: [
    {
      name: "get_current_time",
      description: "the clock",
      parameters: { type: "object", properties: {} },
    },
  ],
};

// the recorded stream behind a fake fetcher, and what the fetcher saw
async function stream(
  body: string,
  status = 200,
  secret: (name: string) => string | null = () => KEY,
): Promise<{
  events: ChatEvent[];
  url: string;
  init: RequestInit | undefined;
}> {
  let init: RequestInit | undefined;
  let url = "";
  const fetcher = (async (input: unknown, options?: RequestInit) => {
    url = String(input);
    init = options;
    return new Response(body, {
      status,
      headers: {
        "content-type":
          status === 200 ? "text/event-stream" : "application/json",
      },
    });
  }) as unknown as typeof fetch;
  const events: ChatEvent[] = [];
  const provider = providerFor(row, { fetcher, secret });
  for await (const event of provider.chat(
    request,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return { events, url, init };
}

describe("OpenRouter chat body", () => {
  test("asks for usage, maps thinking to the reasoning object and sends the session id", () => {
    const body = buildChatBody(request) as any;
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ enabled: true });
    expect(body.session_id).toBe("session-1");
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    // earlier reasoning goes back as OpenRouter's field
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      reasoning: "greet back",
    });
    expect(body.messages[2].reasoning_content).toBeUndefined();
    expect(
      (buildChatBody({ ...request, reasoningEffort: "high" }) as any).reasoning,
    ).toEqual({ effort: "high" });
    expect(
      (buildChatBody({ ...request, reasoningEffort: "none" }) as any).reasoning,
    ).toEqual({ effort: "none" });
    expect(
      (buildChatBody({ ...request, thinking: false }) as any).reasoning,
    ).toEqual({ exclude: true, enabled: false });
    expect(
      (buildChatBody({ ...request, cacheKey: null }) as any).session_id,
    ).toBeUndefined();
  });

  test("marks the system prompt and the last two turns as cache breakpoints on Claude", () => {
    const CLAUDE = "anthropic/claude-sonnet-4.5";
    const body = buildChatBody({ ...request, model: CLAUDE }) as any;
    const part = (text: string) => [
      { type: "text", text, cache_control: { type: "ephemeral" } },
    ];
    expect(body.messages.map((m: any) => m.content)).toEqual([
      part("be brief"),
      "hi",
      part("hello"),
      part("what time is it?"),
    ]);
    expect(
      (buildChatBody(request) as any).messages.map((m: any) => m.content),
    ).toEqual(["be brief", "hi", "hello", "what time is it?"]);
    expect(takesCacheBreakpoints("anthropic/claude-opus-4.7")).toBe(true);
    expect(takesCacheBreakpoints("deepseek/deepseek-v4-flash-0731")).toBe(
      false,
    );
    expect(
      withCacheBreakpoints([
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
        { role: "tool", tool_call_id: "c1", content: "12:00" },
      ]).map((m) => m.content),
    ).toEqual([part("run it"), null, part("12:00")]);
    expect(withCacheBreakpoints([])).toEqual([]);
  });

  test("gives DeepSeek an empty reasoning on every assistant turn that has none", () => {
    const body = buildChatBody({
      ...request,
      model: "deepseek/deepseek-v4-flash-0731",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
        { role: "assistant", content: "hello again", reasoning: "greet" },
        { role: "user", content: "once more" },
      ],
    }) as any;
    expect(body.messages.map((m: any) => m.reasoning)).toEqual([
      undefined,
      "",
      undefined,
      "greet",
      undefined,
    ]);
    expect(
      withEmptyReasoning([
        { role: "assistant", content: null, reasoning_details: [] },
      ])[0]!.reasoning,
    ).toBeUndefined();
  });

  test("sends the structured reasoning back in place of the text when it has it", () => {
    const details = [
      {
        type: "reasoning.text",
        text: "greet back",
        signature: "sig",
        format: "anthropic-claude-v1",
        index: 0,
      },
    ];
    const body = buildChatBody({
      ...request,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning: "greet back",
          reasoningDetails: details,
        },
        { role: "user", content: "again" },
      ],
    }) as any;
    expect(body.messages[1].reasoning_details).toEqual(details);
    expect(body.messages[1].reasoning).toBeUndefined();
  });

  test("merges the streamed pieces of one reasoning item", () => {
    let items = mergeReasoningDetail([], {
      type: "reasoning.text",
      text: "The",
      format: "unknown",
      index: 0,
    });
    items = mergeReasoningDetail(items, {
      type: "reasoning.text",
      text: " user",
      format: "unknown",
      index: 0,
    });
    items = mergeReasoningDetail(items, {
      type: "reasoning.text",
      text: "",
      signature: "sig",
      index: 0,
    });
    items = mergeReasoningDetail(items, {
      type: "reasoning.encrypted",
      data: "blob",
      id: "rs_1",
      index: 1,
    });
    expect(items).toEqual([
      {
        type: "reasoning.text",
        text: "The user",
        format: "unknown",
        signature: "sig",
        index: 0,
      },
      { type: "reasoning.encrypted", data: "blob", id: "rs_1", index: 1 },
    ]);
    expect(
      mergeReasoningDetail(items, { type: "reasoning.summary", summary: "s" }),
    ).toHaveLength(3);
  });
});

describe("OpenRouter stream", () => {
  test("a tool-calling turn: reasoning, the call, the finish and usage with cost", async () => {
    const { events, url, init } = await stream(toolsStream);
    expect(url).toBe("http://router.test/api/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-title"]).toBe("1ctx");
    const reasoning = events
      .filter((e) => e.kind === "reasoning")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(reasoning.length).toBeGreaterThan(0);
    const details = events
      .filter((e) => e.kind === "reasoningDetail")
      .map((e) => (e as Extract<ChatEvent, { kind: "reasoningDetail" }>).item);
    expect(details.length).toBeGreaterThan(1);
    const merged = details.reduce(mergeReasoningDetail, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe(reasoning);
    expect(events.filter((e) => e.kind === "content")).toHaveLength(0);
    const calls = events.find((e) => e.kind === "toolCalls") as Extract<
      ChatEvent,
      { kind: "toolCalls" }
    >;
    expect(calls.calls[0].name).toBe("get_current_time");
    expect(JSON.parse(calls.calls[0].arguments)).toMatchObject({
      timezone: expect.any(String),
    });
    expect(
      events.some((e) => e.kind === "finish" && e.reason === "tool_calls"),
    ).toBe(true);
    const usage = events.find((e) => e.kind === "usage") as Extract<
      ChatEvent,
      { kind: "usage" }
    >;
    expect(usage.usage.cost).toBe(0);
    expect(usage.usage.promptTokens).toBeGreaterThan(0);
    expect(usage.usage.completionTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a plain reply streams reasoning then content and ends with usage", async () => {
    const { events } = await stream(plainStream);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("reasoning")).toBeLessThan(kinds.indexOf("content"));
    const content = events
      .filter((e) => e.kind === "content")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(content).toMatch(/Mac Studio/);
    const usage = events.find((e) => e.kind === "usage") as Extract<
      ChatEvent,
      { kind: "usage" }
    >;
    expect(usage.usage).toMatchObject({
      promptTokens: 27,
      completionTokens: 141,
      cachedTokens: 0,
      cost: 0,
    });
    expect(events.some((e) => e.kind === "finish" && e.reason === "stop")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a refused request surfaces the upstream's words and never the key", async () => {
    const { events } = await stream(refused, 429);
    expect(events).toHaveLength(1);
    const [error] = events as Extract<ChatEvent, { kind: "error" }>[];
    expect(error.message).toBe(
      `OpenRouter 429: ${JSON.parse(refused).error.metadata.raw}`,
    );
    expect(error.message).not.toContain(KEY);
  });

  test("a body that echoes the key has it scrubbed", async () => {
    const { events } = await stream(`{"error":{"message":"bad ${KEY}"}}`, 401);
    expect(events).toEqual([
      { kind: "error", message: "OpenRouter 401: bad [key]" },
    ]);
  });

  test("a fetch that throws is one scrubbed error event, never a throw", async () => {
    const fetcher = (async () => {
      throw new Error(`refused for ${KEY}`);
    }) as unknown as typeof fetch;
    const provider = providerFor(row, { fetcher, secret: () => KEY });
    const events: ChatEvent[] = [];
    for await (const event of provider.chat(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: "error", message: "router failed: refused for [key]" },
    ]);
  });

  test("a stop by the caller ends the stream with no event", async () => {
    const controller = new AbortController();
    const fetcher = (async (_url: unknown, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const provider = providerFor(row, { fetcher, secret: () => KEY });
    const events: ChatEvent[] = [];
    const run = (async () => {
      for await (const event of provider.chat(request, controller.signal)) {
        events.push(event);
      }
    })();
    controller.abort();
    await run;
    expect(events).toEqual([]);
  });

  test("a missing key file is one error and no request", async () => {
    const { events, url } = await stream(plainStream, 200, () => null);
    expect(url).toBe("");
    expect(events).toEqual([
      { kind: "error", message: "router has no key file router.key" },
    ]);
  });

  test("errorText prefers the upstream text, then the message, then the body", () => {
    expect(errorText('{"error":{"message":"bad key"}}')).toBe("bad key");
    expect(errorText("plain text")).toBe("plain text");
    expect(
      errorText(
        '{"error":{"message":"m","metadata":{"raw":"upstream said no"}}}',
      ),
    ).toBe("upstream said no");
  });
});

describe("an OpenAI-compatible provider", () => {
  test("talks the plain wire with no key and no OpenRouter headers", async () => {
    let init: RequestInit | undefined;
    let sent = "";
    const fetcher = (async (_url: unknown, options?: RequestInit) => {
      init = options;
      sent = String(options?.body);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const local = providerFor(
      { ...row, wire: "openai-compatible", keyName: null },
      { fetcher, secret: () => null },
    );
    const events: ChatEvent[] = [];
    for await (const event of local.chat(request, new AbortController().signal))
      events.push(event);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-title"]).toBeUndefined();
    const body = JSON.parse(sent);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning).toBeUndefined();
    expect(body.messages[2].reasoning_content).toBe("greet back");
    // no finish before the end is the wire's own error, not the key's
    expect(events).toEqual([{ kind: "error", message: "stream ended early" }]);
  });
});
