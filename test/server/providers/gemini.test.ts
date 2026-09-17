// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  buildGeminiChatBody as buildChatBody,
  CatalogError,
  type ChatEvent,
  type ChatRequest,
  fetchCatalog,
  geminiError,
  geminiEvents,
  type ProviderRow,
  parseGeminiCatalog as parseCatalog,
} from "../../../src/server/providers/index.ts";
import {
  parseSse,
  ToolCallTracker,
} from "../../../src/server/providers/openai.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import { EFFORTS, isEffort, isWire } from "../../../src/shared/words.ts";
import { fakeFetch, GEMINI_URL } from "../../helpers/app.ts";

const fixture = (name: string) =>
  Bun.file(new URL(`../../fixtures/providers/gemini/${name}`, import.meta.url));
const [catalog, plainStream, toolsStream, refused] = await Promise.all([
  fixture("models.json").json(),
  fixture("chat-stream.sse").text(),
  fixture("chat-tools.sse").text(),
  fixture("error-400.json").text(),
]);
const frames = (stream: string) => parseSse("", stream).frames;
const KEY = "gemini-test-key-that-must-not-leak";
const row: ProviderRow = {
  id: "g1",
  name: "gemini",
  wire: "gemini",
  baseUrl: `${GEMINI_URL}/`,
  keyName: "provider-gemini",
  createdAt: 0,
};
const request: ChatRequest = {
  model: "gemini-3.8-flash",
  messages: [{ role: "user", content: "hello", name: "ana" }],
  thinking: true,
  cacheKey: "session-1",
  temperature: 0,
  topP: 0.8,
  maxTokens: 300,
  tools: [
    {
      name: "datetime",
      description: "the clock",
      parameters: {
        type: "object",
        $defs: { zone: { type: "string" } },
        properties: { tz: { $ref: "#/$defs/zone" } },
        additionalProperties: false,
      },
    },
  ],
};

async function stream(body: string, status = 200) {
  let url = "";
  let init: RequestInit | undefined;
  const fetcher = (async (input: unknown, options?: RequestInit) => {
    url = String(input);
    init = options;
    return new Response(body, { status });
  }) as typeof fetch;
  const events: ChatEvent[] = [];
  for await (const event of providerFor(row, {
    fetcher,
    secret: () => KEY,
  }).chat(request, new AbortController().signal)) {
    events.push(event);
  }
  return { events, url, init };
}

describe("Gemini catalog", () => {
  test("keeps chat models newest first, their windows and flags, without the models prefix", () => {
    const models = parseCatalog(catalog);
    expect(models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
      "gemma-4-31b-it",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
    expect(models.at(-1)).toEqual({
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      contextLength: 1048576,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: true,
    });
    expect(models[2]).toMatchObject({
      name: "Gemma 4 31B IT",
      contextLength: 262144,
      tools: true,
      reasoning: true,
    });
    expect(
      models.every(
        (model) => model.promptPrice === null && model.completionPrice === null,
      ),
    ).toBe(true);
  });

  test.each([
    "tts",
    "image",
    "banana",
    "embedding",
    "live",
    "audio",
    "transcribe",
    "lyria",
    "veo",
    "aqa",
    "robotics",
    "computer-use",
    "deep-research",
    "antigravity",
  ])("excludes %s even with generateContent", (word) => {
    expect(
      parseCatalog({
        models: [
          {
            name: `models/model-${word}`,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    ).toEqual([]);
  });

  test("skips malformed, repeated and non-generating rows", () => {
    const model = {
      name: "models/chat",
      supportedGenerationMethods: ["generateContent"],
    };
    expect(
      parseCatalog({
        models: [
          null,
          {},
          1,
          { ...model, name: "models/" },
          { name: "models/no-methods" },
          { ...model, supportedGenerationMethods: ["countTokens"] },
          model,
          { ...model, name: "chat" },
        ],
      }),
    ).toEqual([
      {
        id: "chat",
        name: "chat",
        contextLength: null,
        promptPrice: null,
        completionPrice: null,
        tools: true,
        reasoning: false,
      },
    ]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ models: "no" })).toEqual([]);
  });

  test("refuses a paginated catalog instead of silently cutting it", async () => {
    const paged = { ...catalog, nextPageToken: "next" };
    expect(() => parseCatalog(paged)).toThrow(CatalogError);
    expect(() => parseCatalog(paged)).toThrow(
      "the catalog has more than a page",
    );
    const fetcher: typeof fetch = Object.assign(
      async () => Response.json(paged),
      { preconnect() {} },
    );
    await expect(fetchCatalog(fetcher, row, KEY)).rejects.toThrow(CatalogError);
  });

  test("uses the native path and key header, never bearer auth", async () => {
    const fake = fakeFetch();
    expect(await fetchCatalog(fake.fetcher, row, KEY)).toEqual(
      parseCatalog(catalog),
    );
    await fetchCatalog(fake.fetcher, row, null);
    expect(fake.calls.map((call) => call.url)).toEqual([
      `${GEMINI_URL}/models?pageSize=1000`,
      `${GEMINI_URL}/models?pageSize=1000`,
    ]);
    expect(fake.calls.map((call) => call.headers)).toEqual([
      { "x-goog-api-key": KEY },
      {},
    ]);
  });
});

describe("Gemini chat body", () => {
  test("keeps accepted fields and schemas but drops cache and plain thinking fields", () => {
    const body = buildChatBody({ ...request, toolChoice: "none" });
    expect(body).toEqual({
      model: request.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      top_p: 0.8,
      max_tokens: 300,
      tools: request.tools!.map((tool) => ({
        type: "function",
        function: tool,
      })),
      tool_choice: "none",
      extra_body: { google: { thinking_config: { include_thoughts: true } } },
    });
    expect(isWire("gemini")).toBe(true);
    expect(EFFORTS.gemini).toEqual(["low", "medium", "high"]);
    expect(isEffort("gemini", "minimal")).toBe(false);
    expect(isEffort("gemini", "xhigh")).toBe(false);
  });

  test.each([
    ["low", 1024],
    ["medium", 8192],
    ["high", 24576],
  ] as const)(
    "maps %s to a Gemini 3 level or an earlier budget",
    (effort, budget) => {
      for (const [model, config] of [
        ["gemini-3.8-flash", { thinking_level: effort }],
        ["gemini-2.5-flash", { thinking_budget: budget }],
      ] as const) {
        const body = buildChatBody({
          ...request,
          model,
          reasoningEffort: effort,
        });
        expect(body.extra_body).toEqual({
          google: { thinking_config: { include_thoughts: true, ...config } },
        });
        expect(body).not.toHaveProperty("reasoning_effort");
      }
    },
  );

  test.each(["gemini-3.8-flash", "gemini-2.5-flash-lite"])(
    "turns thinking off on %s without a thinking config",
    (model) => {
      const body = buildChatBody({
        ...request,
        model,
        thinking: false,
        reasoningEffort: "high",
      });
      expect(body.reasoning_effort).toBe("none");
      expect(body).not.toHaveProperty("extra_body");
      expect(body).not.toHaveProperty("enable_thinking");
    },
  );

  test.each([
    ["gemini-3.1-pro-preview", { thinking_level: "low" }],
    ["gemini-2.5-pro", { thinking_budget: 128 }],
  ])(
    "uses the lowest thinking without thoughts on %s when off",
    (model, config) => {
      const body = buildChatBody({
        ...request,
        model,
        thinking: false,
        reasoningEffort: "high",
      });
      expect(body.extra_body).toEqual({
        google: { thinking_config: { include_thoughts: false, ...config } },
      });
      expect(body).not.toHaveProperty("reasoning_effort");
    },
  );

  test("echoes only same-model call signatures, never assistant reasoning, without changing history", () => {
    const history: ChatRequest = {
      ...request,
      messages: [
        {
          role: "assistant",
          content: "hello",
          reasoning: "greet",
          reasoningDetails: [{ type: "reasoning.encrypted", data: "opaque" }],
        },
        {
          role: "assistant",
          model: request.model,
          content: "",
          reasoning: "check",
          reasoningDetails: [{ type: "reasoning.text", text: "check" }],
          toolCalls: [
            {
              id: "c1",
              name: "datetime",
              arguments: "{}",
              signature: "opaque+/=",
            },
            { id: "c2", name: "datetime", arguments: "{}" },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "noon" },
      ],
    };
    const before = structuredClone(history);
    expect(buildChatBody(history).messages).toEqual([
      { role: "assistant", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "datetime", arguments: "{}" },
            extra_content: { google: { thought_signature: "opaque+/=" } },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "datetime", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "noon" },
    ]);
    expect(history).toEqual(before);
  });

  test.each(["gemini-2.5-flash", "org/other-model", undefined])(
    "drops signatures from %s but keeps its calls and results",
    (model) => {
      const history: ChatRequest = {
        ...request,
        messages: [
          {
            role: "assistant",
            model,
            content: "checking",
            reasoning: "private",
            reasoningDetails: [{ type: "reasoning.text", text: "private" }],
            toolCalls: [
              {
                id: "old",
                name: "datetime",
                arguments: "{}",
                signature: "old-signature",
              },
            ],
          },
          { role: "tool", toolCallId: "old", content: "noon" },
          { role: "user", content: "check again" },
          {
            role: "assistant",
            model: request.model,
            content: null,
            toolCalls: [
              {
                id: "new",
                name: "datetime",
                arguments: "{}",
                signature: "new-signature",
              },
            ],
          },
          { role: "tool", toolCallId: "new", content: "one" },
        ],
      };
      const before = structuredClone(history);
      expect(buildChatBody(history).messages).toEqual([
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "old",
              type: "function",
              function: { name: "datetime", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "old", content: "noon" },
        { role: "user", content: "check again" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "new",
              type: "function",
              function: { name: "datetime", arguments: "{}" },
              extra_content: {
                google: { thought_signature: "new-signature" },
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "new", content: "one" },
      ]);
      expect(history).toEqual(before);
    },
  );
});

describe("Gemini stream", () => {
  test("streams thoughts and an answer, drops text signatures and counts thoughts in usage", async () => {
    const { events, url, init } = await stream(plainStream);
    expect(url).toBe(`${GEMINI_URL}/openai/chat/completions`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.has("x-goog-api-key")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual(buildChatBody(request));
    const thought = events.find((event) => event.kind === "reasoning");
    expect(thought).toMatchObject({
      text: expect.stringContaining("**Calculating Prime Numbers**"),
    });
    expect(events.filter((event) => event.kind === "content")).toEqual([
      { kind: "content", text: "6" },
    ]);
    expect(events.filter((event) => event.kind === "usage").at(-1)).toEqual({
      kind: "usage",
      usage: {
        promptTokens: 23,
        completionTokens: 372,
        reasoningTokens: 371,
        cachedTokens: null,
        cost: null,
      },
    });
    expect(events.filter((event) => event.kind === "finish")).toEqual([
      { kind: "finish", reason: "stop", details: null },
    ]);
    expect(JSON.stringify(events)).not.toContain("<thought>");
    expect(JSON.stringify(events)).not.toContain("thought_signature");
    expect(
      events.some(
        (event) => event.kind === "error" || event.kind === "toolCalls",
      ),
    ).toBe(false);
  });

  test("cuts boundary tags only once and keeps each stream's state separate", () => {
    const one = geminiEvents();
    const two = geminiEvents();
    const thoughtFrame = frames(plainStream)[0]!;
    one(thoughtFrame);
    expect(
      one(thoughtFrame).find((event) => event.kind === "reasoning"),
    ).toMatchObject({ text: expect.stringContaining("<thought>") });
    const answer = JSON.stringify({
      choices: [{ delta: { content: "</thought>answer" } }],
    });
    expect(two(answer)).toEqual([
      { kind: "content", text: "</thought>answer" },
    ]);
    expect(one(answer)).toEqual([{ kind: "content", text: "answer" }]);
    expect(one(answer)).toEqual([
      { kind: "content", text: "</thought>answer" },
    ]);
    expect(one("[DONE]")).toEqual([]);
    expect(one("{")).toEqual([
      { kind: "error", message: "invalid JSON in the stream" },
    ]);
  });

  test("collects a signed call even though the recorded finish is stop", async () => {
    const { events } = await stream(toolsStream);
    const call = events.find((event) => event.kind === "toolCallDelta");
    expect(call).toMatchObject({
      id: "call_85730",
      name: "datetime",
      arguments: '{"tz":"Europe/Bucharest"}',
      signature: expect.any(String),
    });
    expect(events.find((event) => event.kind === "toolCalls")).toEqual({
      kind: "toolCalls",
      calls: [
        {
          id: call!.id!,
          name: call!.name!,
          arguments: call!.arguments!,
          signature: call!.signature,
        },
      ],
    });
    expect(events.find((event) => event.kind === "finish")).toMatchObject({
      reason: "stop",
    });
    expect(
      events.filter((event) => event.kind === "usage").at(-1),
    ).toMatchObject({
      usage: { promptTokens: 56, completionTokens: 55, reasoningTokens: 38 },
    });
  });

  test("keeps the last signature per call, including a signature-only fragment", () => {
    const tracker = new ToolCallTracker();
    const map = geminiEvents();
    const push = (calls: object[]) => {
      for (const event of map(
        JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] }),
      )) {
        if (event.kind === "toolCallDelta") tracker.push(event);
      }
    };
    push([
      {
        index: 0,
        id: "a",
        function: { name: "first", arguments: "{" },
        extra_content: { google: { thought_signature: "old" } },
      },
      { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
    ]);
    push([
      {
        index: 0,
        function: { arguments: "}" },
        extra_content: { google: { thought_signature: "new+/=" } },
      },
    ]);
    push([
      { index: 1, extra_content: { google: { thought_signature: "second" } } },
    ]);
    push([{ index: 0, extra_content: { google: { thought_signature: 42 } } }]);
    expect(tracker.flush()).toEqual([
      { id: "a", name: "first", arguments: "{}", signature: "new+/=" },
      { id: "b", name: "second", arguments: "{}", signature: "second" },
    ]);
  });

  test.each([20, 18])(
    "leaves nonpositive reasoning null when total is %i",
    (total) => {
      const events = geminiEvents()(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 5,
            total_tokens: total,
            prompt_tokens_details: { cached_tokens: 7 },
            cost: 100,
          },
        }),
      );
      expect(events).toEqual([
        {
          kind: "usage",
          usage: {
            promptTokens: 15,
            completionTokens: total - 15,
            reasoningTokens: null,
            cachedTokens: 7,
            cost: null,
          },
        },
      ]);
    },
  );
});

describe("Gemini errors", () => {
  test("uses Google's refusal and scrubs the key", async () => {
    const message = JSON.parse(refused)[0].error.message;
    expect(geminiError(`HTTP 400: ${refused}`)).toBe(`Gemini 400: ${message}`);
    const { events } = await stream(
      refused.replace("default_api:datetime", KEY),
      400,
    );
    expect(events).toEqual([
      {
        kind: "error",
        message: `Gemini 400: ${message.replace("default_api:datetime", "[key]")}`,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  test.each([
    "HTTP 502",
    "HTTP 502: not JSON",
    "HTTP 400: []",
    "connection failed",
  ])("keeps a failure without Google's message: %s", (message) => {
    expect(geminiError(message)).toBe(message);
  });
});
