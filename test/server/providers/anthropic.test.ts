// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The anthropic wire: the Messages body for each history shape, ids
// rewritten, thinking replayed and its records projected, the cache
// marks, the cap, the recorded streams read into events, the read ended
// on message_stop, the errors in the wire's words, the refused replay
// adapted once, the described catalog, the count and the cost.

import { describe, expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";
import {
  buildAnthropicChatBody as buildChatBody,
  CatalogError,
  type ChatEvent,
  type ChatRequest,
  costOf,
  fetchCatalog,
  maxTokensOf,
  modelPrice,
  type ProviderRow,
  parseAnthropicModels,
  requestText,
  wireTokens,
  withModelsDev,
} from "../../../src/server/providers/index.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import { fixedThinking } from "../../../src/shared/thinking.ts";
import { EFFORTS, isWire } from "../../../src/shared/words.ts";
import {
  type Answer,
  anthropicFetch,
  anthropicFixture,
  frames,
  type Recorded,
  recorded,
  refusal,
  stream,
} from "../../helpers/anthropic.ts";
import {
  ANTHROPIC_CHAT,
  ANTHROPIC_MODELS,
  ANTHROPIC_URL,
  collectLogs,
  fakeFetch,
} from "../../helpers/app.ts";

const KEY = "sk-ant-test-key-that-must-not-leak";
const row: ProviderRow = {
  id: "an1",
  name: "anthropic",
  wire: "anthropic",
  baseUrl: ANTHROPIC_URL,
  keyName: "provider-anthropic",
  createdAt: 0,
};

const tool = {
  name: "weather",
  description: "Get weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const thought = {
  type: "thinking",
  index: 0,
  thinking: "think about Y",
  signature: "sig-1",
};

// every shape: two system parts, a named user, a work reply with a
// signed, an unsigned and a redacted thinking record, text and two
// calls, their results (one failed), then an answer and a user turn
const request: ChatRequest = {
  model: "claude-haiku-5-5",
  messages: [
    { role: "system", content: "be brief" },
    { role: "system", content: "use the tools" },
    { role: "user", content: "weather in Y?", name: "ana" },
    {
      role: "assistant",
      model: "claude-haiku-5-5",
      content: "Checking.",
      reasoning: "think about Y",
      reasoningDetails: [
        thought,
        { type: "thinking", index: 1, thinking: "cut", signature: "" },
        { type: "redacted_thinking", index: 2, data: "opaque" },
      ],
      toolCalls: [
        { id: "toolu_1", name: "weather", arguments: '{"city":"Y"}' },
        { id: "toolu_2", name: "weather", arguments: "[1]" },
      ],
    },
    { role: "tool", toolCallId: "toolu_1", content: '{"temp_c":14}' },
    { role: "tool", toolCallId: "toolu_2", content: "no city", failed: true },
    { role: "assistant", content: "It is 14 C." },
    { role: "user", content: "thanks" },
  ],
  thinking: true,
  cacheKey: "session-1",
  tools: [tool],
};

async function run(
  answers: Answer[],
  req: ChatRequest = request,
  logs = collectLogs(),
) {
  const fake = anthropicFetch();
  fake.queue.push(...answers);
  const provider = providerFor(row, {
    fetcher: fake.fetcher,
    secret: () => KEY,
    log: logs.logFactory("providers"),
  });
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(req, new AbortController().signal)) {
    events.push(event);
  }
  return { events, fake, logs };
}

const visible = (events: ChatEvent[]) =>
  events.filter((event) => event.kind !== "alive");
const of = <K extends ChatEvent["kind"]>(events: ChatEvent[], kind: K) =>
  events.filter((e): e is Extract<ChatEvent, { kind: K }> => e.kind === kind);

describe("the anthropic wire", () => {
  test("is a wire with all five efforts", () => {
    expect(isWire("anthropic")).toBe(true);
    expect(EFFORTS.anthropic).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  describe("the body", () => {
    test("is the Messages body: thinking, text, calls, merged results and the marks", () => {
      expect(buildChatBody(request)).toEqual({
        model: "claude-haiku-5-5",
        max_tokens: 64_000,
        system: [
          {
            type: "text",
            text: "be brief\n\nuse the tools",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "[ana] weather in Y?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "think about Y",
                signature: "sig-1",
              },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "Checking." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "weather",
                input: { city: "Y" },
              },
              { type: "tool_use", id: "toolu_2", name: "weather", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: '{"temp_c":14}',
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                content: "no city",
                is_error: true,
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "It is 14 C.",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "thanks",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            input_schema: tool.parameters,
          },
        ],
        thinking: { type: "adaptive", display: "summarized" },
        stream: true,
      });
    });

    test("consecutive turns of one role merge, and a mark never sits on thinking", () => {
      const body = buildChatBody({
        model: "m",
        thinking: false,
        messages: [
          { role: "user", content: "one" },
          { role: "user", content: "" },
          { role: "user", content: "two" },
          {
            role: "assistant",
            content: "",
            reasoningDetails: [thought],
            toolCalls: [{ id: "a", name: "weather", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "a", content: "ok" },
          { role: "user", content: "You cannot call tools any more." },
        ],
      });
      expect(body.system).toBeUndefined();
      expect(body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "think about Y", signature: "sig-1" },
            {
              type: "tool_use",
              id: "a",
              name: "weather",
              input: {},
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "ok" },
            {
              type: "text",
              text: "You cannot call tools any more.",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ]);
    });

    test("ids from another provider are made safe and unique, results paired by position", () => {
      const body = buildChatBody({
        model: "m",
        thinking: false,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_0", name: "a", arguments: "{}" },
              { id: "call_0", name: "b", arguments: "{}" },
            ],
          },
          { role: "tool", toolCallId: "call_0", content: "1" },
          { role: "tool", toolCallId: "call_0", content: "2" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_0", name: "c", arguments: "not json" },
              { id: "functions.get:7", name: "d", arguments: "null" },
            ],
          },
          { role: "tool", toolCallId: "call_0", content: "3" },
          { role: "tool", toolCallId: "functions.get:7", content: "4" },
        ],
      });
      const blocks = (body.messages as { content: any[] }[]).flatMap(
        (turn) => turn.content,
      );
      const uses = blocks.filter((b) => b.type === "tool_use");
      const results = blocks.filter((b) => b.type === "tool_result");
      expect(uses.map((b) => b.id)).toEqual([
        "call_0",
        "call_0_2",
        "call_0_3",
        "functions_get_7",
      ]);
      expect(results.map((b) => b.tool_use_id)).toEqual(uses.map((b) => b.id));
      expect(uses.map((b) => b.input)).toEqual([{}, {}, {}, {}]);
      for (const id of uses.map((b) => b.id)) {
        expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });

    test("thinking: Off and a least that can stop are disabled, an effort goes in output_config", () => {
      const thinking = (req: Partial<ChatRequest>) => {
        const body = buildChatBody({ ...request, ...req });
        return { thinking: body.thinking, output_config: body.output_config };
      };
      const adaptive = { type: "adaptive", display: "summarized" };
      expect(thinking({ thinking: false, thinkingOff: true })).toEqual({
        thinking: { type: "disabled" },
        output_config: undefined,
      });
      expect(thinking({ thinking: false, least: true })).toEqual({
        thinking: { type: "disabled" },
        output_config: undefined,
      });
      expect(thinking({ thinking: true })).toEqual({
        thinking: adaptive,
        output_config: undefined,
      });
      expect(thinking({ thinking: true, reasoningEffort: "xhigh" })).toEqual({
        thinking: adaptive,
        output_config: { effort: "xhigh" },
      });
      // a model that always thinks gets its least as the first effort
      expect(
        thinking({ thinking: true, least: true, reasoningEffort: "low" }),
      ).toEqual({ thinking: adaptive, output_config: { effort: "low" } });
    });

    test("sampling goes only when set", () => {
      expect(buildChatBody(request)).not.toContainKeys([
        "temperature",
        "top_p",
      ]);
      expect(
        buildChatBody({ ...request, temperature: 0.2, topP: 0.9 }),
      ).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    });

    test("max_tokens is the least of the round's cap, the model's and 64K", () => {
      const cap = (req: Partial<ChatRequest>) =>
        maxTokensOf({ ...request, ...req });
      expect(cap({})).toBe(64_000);
      expect(cap({ outputLimit: 128_000 })).toBe(64_000);
      expect(cap({ outputLimit: 32_000 })).toBe(32_000);
      expect(cap({ maxTokens: 4000, outputLimit: 128_000 })).toBe(4000);
      // a summary or attention round on a model that always thinks
      expect(cap({ maxTokens: 128, least: true, thinking: true })).toBe(1024);
      expect(cap({ maxTokens: 128, least: true, thinking: false })).toBe(128);
      expect(buildChatBody({ ...request, maxTokens: 300 }).max_tokens).toBe(
        300,
      );
    });

    test("drops every thinking record when asked", () => {
      const body = buildChatBody(request, { dropThinking: true });
      expect(JSON.stringify(body)).not.toContain('thinking","thinking');
      expect(JSON.stringify(body)).not.toContain("redacted_thinking");
    });
  });

  describe("the stream", () => {
    // the usage event the file's last message_delta makes: the prompt is
    // the uncached input plus the cache read and written
    const usageOf = (file: Recorded) => ({
      promptTokens:
        file.usage.input_tokens +
        file.usage.cache_read_input_tokens +
        file.usage.cache_creation_input_tokens,
      completionTokens: file.usage.output_tokens,
      cachedTokens: file.usage.cache_read_input_tokens,
      cacheWriteTokens: file.usage.cache_creation_input_tokens,
      reasoningTokens: file.usage.output_tokens_details.thinking_tokens,
      cost: null,
    });
    const callsOf = (file: Recorded) =>
      file.blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "",
          name: b.name ?? "",
          arguments: b.json,
        }));
    const joined = (events: ChatEvent[], kind: "content" | "reasoning") =>
      of(events, kind)
        .map((e) => e.text)
        .join("");

    test("a recorded tool round streams the call and ends on tool_use", async () => {
      const file = recorded("chat-tool-round.sse");
      const { events } = await run([stream("chat-tool-round.sse")]);
      expect(file.stopReason).toBe("tool_use");
      expect(of(events, "toolCalls")).toEqual([
        { kind: "toolCalls", calls: callsOf(file) },
      ]);
      expect(JSON.parse(callsOf(file)[0]!.arguments)).toHaveProperty("city");
      expect(of(events, "usage")).toEqual([
        { kind: "usage", usage: usageOf(file) },
      ]);
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "tool_calls", details: null },
      ]);
      // message_start, content_block_start and ping show nothing
      expect(events[0]).toEqual({ kind: "alive", thinking: false });
      expect(of(events, "error")).toEqual([]);
    });

    test("the recorded continuation thinks, keeps the signed block and answers", async () => {
      const file = recorded("chat-tool-result.sse");
      expect(file.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
      const { events } = await run([stream("chat-tool-result.sse")]);
      const reasoning = joined(events, "reasoning");
      expect(reasoning).toBe(file.blocks[0]!.thinking);
      expect(of(events, "reasoningDetail")).toEqual([
        {
          kind: "reasoningDetail",
          item: {
            type: "thinking",
            index: 0,
            thinking: reasoning,
            signature: file.blocks[0]!.signature,
          },
        },
      ]);
      expect(file.blocks[0]!.signature).not.toBe("");
      expect(joined(events, "content")).toBe(file.blocks[1]!.text);
      // the idle check is lifted while the thinking block is open
      const alive = of(events, "alive")
        .map((e) => e.thinking)
        .filter((now, i, all) => i === 0 || now !== all[i - 1]);
      expect(alive).toEqual([false, true, false]);
      expect(of(events, "usage")[0]?.usage).toEqual(usageOf(file));
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "stop", details: null },
      ]);
    });

    test("thinking off answers with text alone", async () => {
      const { events } = await run([stream("chat-thinking-off.sse")]);
      expect(visible(events).map((e) => e.kind)).toEqual([
        "content",
        "usage",
        "finish",
      ]);
    });

    test("recorded parallel calls come out in order, whole", async () => {
      const file = recorded("chat-parallel-calls.sse");
      expect(callsOf(file)).toHaveLength(2);
      const { events } = await run([stream("chat-parallel-calls.sse")]);
      expect(of(events, "toolCalls")[0]?.calls).toEqual(callsOf(file));
      expect(of(events, "finish")[0]?.reason).toBe("tool_calls");
    });

    test("thinking and text before two calls keep that order, one record", async () => {
      const file = recorded("chat-parallel-calls-handmade.sse");
      const { events } = await run([
        stream("chat-parallel-calls-handmade.sse"),
      ]);
      expect(of(events, "toolCalls")[0]?.calls).toEqual(callsOf(file));
      expect(of(events, "reasoningDetail")).toHaveLength(1);
      expect(joined(events, "content")).toBe(file.blocks[1]!.text);
    });

    test("usage adds the cache to the uncached input, written then read", async () => {
      const write = recorded("chat-cached-write.sse");
      const read = recorded("chat-cached-read.sse");
      // the pair caches one prefix: what the first wrote the second read
      expect(write.usage.cache_creation_input_tokens).toBeGreaterThan(0);
      expect(read.usage.cache_read_input_tokens).toBe(
        write.usage.cache_creation_input_tokens,
      );
      const price = modelPrice("anthropic", "claude-haiku-5-5")!;
      for (const [name, file] of [
        ["chat-cached-write.sse", write],
        ["chat-cached-read.sse", read],
      ] as const) {
        const { events } = await run([stream(name)]);
        const [usage] = of(events, "usage");
        expect(usage?.usage).toEqual(usageOf(file));
        const u = file.usage;
        expect(costOf(usage!.usage, "anthropic", price)).toBeCloseTo(
          (u.input_tokens * price.input +
            u.cache_read_input_tokens * price.cacheRead +
            u.cache_creation_input_tokens * price.cacheWrite +
            u.output_tokens * price.output) /
            1e6,
          12,
        );
      }
    });

    test("a summary on a model that always thinks keeps its words and its record", async () => {
      const file = recorded("chat-summary-opus.sse");
      expect(file.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
      const { events } = await run([stream("chat-summary-opus.sse")]);
      expect(joined(events, "content")).toBe(file.blocks[1]!.text);
      expect(of(events, "reasoningDetail")).toHaveLength(1);
      expect(of(events, "finish")[0]?.reason).toBe("stop");
    });

    test("max_tokens and a full window are length", async () => {
      expect(recorded("chat-max-tokens.sse").stopReason).toBe("max_tokens");
      const { events } = await run([stream("chat-max-tokens.sse")]);
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "length", details: null },
      ]);
      const window = await run([
        frames(
          { type: "message_start", message: {} },
          {
            type: "message_delta",
            delta: { stop_reason: "model_context_window_exceeded" },
          },
          { type: "message_stop" },
        ),
      ]);
      expect(of(window.events, "finish")[0]?.reason).toBe("length");
    });

    test("a refusal is content_filter with its explanation as the words, pause_turn a stop", async () => {
      const refused = await run([
        frames(
          { type: "message_start", message: {} },
          {
            type: "message_delta",
            delta: {
              stop_reason: "refusal",
              stop_details: { type: "refusal", explanation: "Not this." },
            },
          },
          { type: "message_stop" },
        ),
      ]);
      expect(visible(refused.events)).toEqual([
        { kind: "content", text: "Not this." },
        { kind: "finish", reason: "content_filter", details: "refusal" },
      ]);
      const paused = await run([
        frames(
          { type: "message_delta", delta: { stop_reason: "pause_turn" } },
          { type: "message_stop" },
        ),
      ]);
      expect(of(paused.events, "finish")).toEqual([
        { kind: "finish", reason: "stop", details: "pause_turn" },
      ]);
    });

    test("message_stop ends the read with no [DONE] and the connection open", async () => {
      const answer = stream("chat-thinking-off.sse");
      const { events } = await run([{ ...answer, open: true }]);
      expect(of(events, "finish")).toHaveLength(1);
      expect(of(events, "error")).toEqual([]);
    });

    test("an error frame is the provider's words, its type the code and a status to retry on", async () => {
      const { events } = await run([stream("chat-overloaded-handmade.sse")]);
      expect(of(events, "error")[0]).toEqual({
        kind: "error",
        message: "overloaded_error: Overloaded",
        remote: true,
        status: 529,
        code: "overloaded_error",
      });
      const other = await run([
        frames({
          type: "error",
          error: { type: "invalid_request_error", message: "bad" },
        }),
      ]);
      expect(of(other.events, "error")[0]).toEqual({
        kind: "error",
        message: "invalid_request_error: bad",
        remote: true,
        code: "invalid_request_error",
      });
    });
  });

  describe("the errors and headers", () => {
    test("a refused request is its type and message with the status", async () => {
      const { events, fake } = await run([refusal("error-401.json", 401)]);
      expect(events).toEqual([
        {
          kind: "error",
          message: "authentication_error: invalid x-api-key",
          status: 401,
          remote: true,
          code: "authentication_error",
        },
      ]);
      expect(fake.calls[0]).toMatchObject({
        url: ANTHROPIC_CHAT,
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      });
      expect(fake.calls[0]?.headers).not.toContainKey("authorization");
      const missing = await run([refusal("error-no-max-tokens.json")], {
        ...request,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(missing.events[0]).toMatchObject({
        message: "invalid_request_error: max_tokens: Field required",
        status: 400,
      });
    });

    test("the key never rides in an error", async () => {
      const { events } = await run([
        {
          status: 401,
          body: JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: `bad ${KEY}` },
          }),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(KEY);
    });
  });

  describe("the refused replay", () => {
    test("a 400 on a body with thinking is sent once more without it, then forgotten", async () => {
      const logs = collectLogs();
      const { events, fake } = await run(
        [
          refusal("error-refused-replay-handmade.json"),
          stream("chat-thinking-off.sse"),
        ],
        request,
        logs,
      );
      const bodies = fake.bodies();
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[0])).toContain('"signature":"sig-1"');
      expect(JSON.stringify(bodies[1])).not.toContain("signature");
      expect(JSON.stringify(bodies[1])).not.toContain("redacted_thinking");
      expect(events[0]).toEqual({ kind: "reasoningRefused" });
      expect(of(events, "error")).toEqual([]);
      expect(of(events, "finish")).toHaveLength(1);
      expect(logs.events.map((e) => e.msg)).toContain(
        "stored reasoning dropped",
      );
    });

    test("an unrelated 400 on the resend fails in its own words and forgets nothing", async () => {
      const { events, fake } = await run([
        refusal("error-refused-replay-handmade.json"),
        refusal("error-no-max-tokens.json"),
      ]);
      expect(fake.bodies()).toHaveLength(2);
      expect(of(events, "reasoningRefused")).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({
          kind: "error",
          message: "invalid_request_error: max_tokens: Field required",
        }),
      ]);
    });

    test("a 400 on a body with no thinking is the round's error, sent once", async () => {
      const { events, fake } = await run(
        [refusal("error-refused-replay-handmade.json")],
        { ...request, messages: [{ role: "user", content: "hi" }] },
      );
      expect(fake.bodies()).toHaveLength(1);
      expect(of(events, "error")).toHaveLength(1);
      expect(of(events, "reasoningRefused")).toEqual([]);
    });

    test("a 529 is not adapted: the round retries it", async () => {
      const { events, fake } = await run([
        {
          status: 529,
          body: JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
        },
      ]);
      expect(fake.bodies()).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 529,
        code: "overloaded_error",
      });
    });
  });

  describe("the catalog", () => {
    test("is the recorded model list, described, with each model's thinking and cap", async () => {
      const models = await fetchCatalog(fakeFetch().fetcher, row, KEY);
      expect(models).toHaveLength(14);
      const byId = new Map(models.map((m) => [m.id, m]));
      expect(byId.get("claude-haiku-5-5")).toEqual({
        id: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        contextLength: 1_000_000,
        promptPrice: 0.1,
        completionPrice: 0.5,
        tools: true,
        reasoning: true,
        thinkingRequired: false,
        reasoningKnown: true,
        described: true,
        listedAs: "claude-haiku-5-5",
        outputLimit: 128_000,
      });
      // Sonnet 5.5 refuses disabled: only On is offered
      const sonnet = byId.get("claude-sonnet-5-5")!;
      expect(sonnet).toMatchObject({ thinkingRequired: true, reasoning: true });
      expect(fixedThinking(sonnet)).toBe("on");
      // the 4.5 models take no adaptive thinking: they run with it off
      const old = byId.get("claude-haiku-4-5-20251001")!;
      expect(old).toMatchObject({
        contextLength: 200_000,
        outputLimit: 64_000,
        reasoning: false,
        promptPrice: 1,
      });
      expect(fixedThinking(old)).toBe("off");
      expect(fixedThinking(byId.get("claude-haiku-5-5")!)).toBeNull();
    });

    test("is read at limit 1000 with the version header, a key or none", async () => {
      const fake = fakeFetch();
      await fetchCatalog(fake.fetcher, row, KEY);
      await fetchCatalog(fake.fetcher, row, null);
      expect(fake.calls.map((call) => call.url)).toEqual([
        ANTHROPIC_MODELS,
        ANTHROPIC_MODELS,
      ]);
      expect(fake.calls[0]?.headers).toMatchObject({
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      });
      expect(fake.calls[1]?.headers).toEqual({
        "anthropic-version": "2023-06-01",
      });
    });

    test("a further page is an error, never a cut", () => {
      const body = JSON.parse(anthropicFixture("models.json"));
      expect(() => parseAnthropicModels({ ...body, has_more: true })).toThrow(
        CatalogError,
      );
    });

    test("a row with no capabilities is not known to think", () => {
      const [m] = parseAnthropicModels({
        data: [{ id: "x", max_input_tokens: 100_000 }],
      });
      expect(m).toMatchObject({
        reasoningKnown: false,
        reasoning: false,
        thinkingRequired: false,
        described: true,
      });
      expect(m).not.toContainKey("outputLimit");
      expect(withModelsDev(m!, "anthropic")).toMatchObject({
        listedAs: "x",
        promptPrice: null,
      });
    });
  });

  describe("the count", () => {
    test("a thinking block counts by its text, never its signature", () => {
      const signature = "s".repeat(4000);
      const req: ChatRequest = {
        model: "m",
        thinking: true,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "hello",
            reasoningDetails: [
              { type: "thinking", index: 0, thinking: "think", signature },
            ],
          },
        ],
      };
      const text = requestText("anthropic", req);
      expect(text).toContain("think");
      expect(text).not.toContain(signature);
      expect(text).not.toContain("cache_control");
    });

    test("the tools count as Messages tool objects", () => {
      const tools = [tool];
      expect(wireTokens(tools, "anthropic")).toBe(
        tokens(
          JSON.stringify([
            {
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            },
          ]),
        ),
      );
      expect(wireTokens(tools, "anthropic")).not.toBe(wireTokens(tools));
      expect(wireTokens([], "anthropic")).toBe(0);
    });
  });
});
