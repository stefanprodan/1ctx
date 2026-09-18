// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The openai-strict wire against what NVIDIA NIM and Groq were recorded
// answering (test/fixtures/providers/strict/): a body with nothing
// outside the OpenAI spec, thinking in reasoning_effort alone, the
// plain wire's stream, and a catalog that lists only ids beside one
// that describes its models.

import { describe, expect, test } from "bun:test";
import {
  buildStrictChatBody as buildChatBody,
  type ChatEvent,
  type ChatRequest,
  fetchCatalog,
  type ProviderRow,
  parseCatalog,
} from "../../../src/server/providers/index.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import { EFFORTS, isWire } from "../../../src/shared/words.ts";
import { fakeFetch, GROQ_URL, NIM_URL } from "../../helpers/app.ts";

const fixture = (name: string) =>
  Bun.file(new URL(`../../fixtures/providers/strict/${name}`, import.meta.url));
const KEY = "nvapi-test-key-that-must-not-leak";
const row = (baseUrl: string): ProviderRow => ({
  id: "s1",
  name: "nvidia",
  wire: "openai-strict",
  baseUrl,
  keyName: "provider-nvidia",
  createdAt: 0,
});
const request: ChatRequest = {
  model: "nvidia/nemotron-3-ultra-550b-a55b",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "what time is it", name: "ana" },
    {
      role: "assistant",
      content: "",
      reasoning: "check the clock",
      reasoningDetails: [{ type: "reasoning.text", text: "check the clock" }],
      toolCalls: [{ id: "call_1", name: "datetime", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call_1", content: "noon" },
  ],
  thinking: true,
  reasoningEffort: "low",
  cacheKey: "session-1",
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 300,
  tools: [{ name: "datetime", description: "the clock", parameters: {} }],
};

async function stream(
  baseUrl: string,
  req: ChatRequest = request,
  fetcher = fakeFetch(),
) {
  const provider = providerFor(row(baseUrl), {
    fetcher: fetcher.fetcher,
    secret: () => KEY,
  });
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(req, new AbortController().signal)) {
    events.push(event);
  }
  return { events, calls: fetcher.calls };
}

describe("the openai-strict wire", () => {
  test("is a wire with the levels both recorded hosts take", () => {
    expect(isWire("openai-strict")).toBe(true);
    expect(EFFORTS["openai-strict"]).toEqual(["low", "medium", "high"]);
  });
});

describe("strict chat body", () => {
  test("keeps the spec fields and drops every field outside it", () => {
    const body = buildChatBody(request);
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "reasoning_effort",
      "stream",
      "stream_options",
      "temperature",
      "tools",
      "top_p",
    ]);
    expect(body.reasoning_effort).toBe("low");
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "user",
      content: "what time is it",
      name: "ana",
    });
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
    });
    // the request is the caller's and stays as it was
    expect(request.messages[2]).toHaveProperty("reasoningDetails");
  });

  test("sends earlier plain reasoning as reasoning, never reasoning_content", () => {
    const body = buildChatBody({
      ...request,
      messages: [{ role: "assistant", content: "hi", reasoning: "think" }],
    });
    expect((body.messages as Record<string, unknown>[])[0]).toEqual({
      role: "assistant",
      content: "hi",
      reasoning: "think",
    });
  });

  test("turns thinking off only on the agent's own Off", () => {
    const off = { ...request, thinking: false, reasoningEffort: null };
    expect(buildChatBody({ ...off, thinkingOff: true }).reasoning_effort).toBe(
      "none",
    );
    // a default that resolved to off, or a summary round: a model that
    // never thinks refuses the field, so nothing is sent
    expect(buildChatBody(off)).not.toHaveProperty("reasoning_effort");
    expect(buildChatBody({ ...off, thinkingOff: false })).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  test("sends no effort when thinking is on without one", () => {
    expect(
      buildChatBody({ ...request, reasoningEffort: null }),
    ).not.toHaveProperty("reasoning_effort");
  });
});

describe("strict catalog", () => {
  test("a NIM catalog lists only ids, so every row is undescribed", async () => {
    const models = parseCatalog(await fixture("nim-models.json").json());
    expect(models.map((m) => m.id)).toEqual([
      "01-ai/yi-large",
      "nvidia/nemotron-3-embed-1b",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
    for (const m of models) {
      expect(m).toEqual({
        id: m.id,
        name: m.id,
        contextLength: null,
        promptPrice: null,
        completionPrice: null,
        tools: false,
        reasoning: false,
        described: false,
      });
    }
  });

  test("a Groq catalog describes the window, prices and features", async () => {
    const models = parseCatalog(await fixture("groq-models.json").json());
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get("openai/gpt-oss-120b")).toEqual({
      id: "openai/gpt-oss-120b",
      name: "GPT OSS 120B",
      contextLength: 131072,
      promptPrice: 0.15,
      completionPrice: 0.6,
      tools: true,
      reasoning: true,
      described: true,
    });
    expect(byId.get("whisper-large-v3")).toMatchObject({
      contextLength: 448,
      tools: false,
      reasoning: false,
      described: true,
    });
  });

  test("reads the list under the base URL with the key as a bearer", async () => {
    const fake = fakeFetch();
    const models = await fetchCatalog(fake.fetcher, row(GROQ_URL), KEY);
    expect(models.length).toBe(4);
    expect(fake.calls).toEqual([
      {
        url: `${GROQ_URL}/models`,
        headers: { authorization: `Bearer ${KEY}` },
        body: null,
      },
    ]);
  });
});

describe("strict stream", () => {
  test("a recorded NIM reply streams reasoning_content, the answer and usage", async () => {
    const { events, calls } = await stream(NIM_URL, {
      ...request,
      tools: undefined,
    });
    expect(calls[0]!.url).toBe(`${NIM_URL}/chat/completions`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).not.toHaveProperty("enable_thinking");
    expect(sent).not.toHaveProperty("prompt_cache_key");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("content");
    expect(kinds.at(-1)).toBe("usage");
    expect(events.at(-1)).toEqual({
      kind: "usage",
      usage: {
        promptTokens: 29,
        completionTokens: 151,
        cachedTokens: null,
        reasoningTokens: null,
        cost: null,
      },
    });
    expect(kinds).not.toContain("error");
  });

  test("a recorded Groq tool round streams reasoning and one whole call", async () => {
    const { events } = await stream(GROQ_URL, {
      ...request,
      messages: request.messages.slice(0, 2),
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("reasoning");
    const calls = events.find((e) => e.kind === "toolCalls") as Extract<
      ChatEvent,
      { kind: "toolCalls" }
    >;
    expect(calls.calls.map((call) => call.name)).toEqual(["datetime"]);
    expect(
      events.some((e) => e.kind === "finish" && e.reason === "tool_calls"),
    ).toBe(true);
    expect(events.find((e) => e.kind === "usage")).toMatchObject({
      usage: { promptTokens: 123, completionTokens: 25, reasoningTokens: 7 },
    });
  });

  test("a refusal is the server's words with the key scrubbed", async () => {
    const refused = (await fixture("groq-error-400.json").text()).trim();
    const fetcher = (async () =>
      new Response(refused.replace("this model", KEY), {
        status: 400,
      })) as unknown as typeof fetch;
    const { events } = await stream(GROQ_URL, request, {
      fetcher,
      calls: [],
    });
    expect(events).toEqual([
      {
        kind: "error",
        message: `HTTP 400: ${refused.replace("this model", "[key]")}`,
      },
    ]);
  });
});
