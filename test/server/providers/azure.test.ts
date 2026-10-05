// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The azure wire: the Responses body for each history shape, the stored
// records projected, the recorded streams read into events, the read
// ended on the terminal event, the errors in the wire's words, the two
// refusals adapted once each, the deployments catalog and the count.

import { describe, expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";
import {
  azureBaseUrlProblem,
  buildAzureChatBody as buildChatBody,
  CatalogError,
  type ChatEvent,
  type ChatRequest,
  fetchCatalog,
  type ProviderRow,
  parseDeployments,
  requestTokens,
  wireTokens,
  withModelsDev,
} from "../../../src/server/providers/index.ts";
import { providerFor } from "../../../src/server/providers/provider.ts";
import { EFFORTS, isEffort, isWire } from "../../../src/shared/words.ts";
import {
  AZURE_CHAT,
  AZURE_DEPLOYMENTS,
  AZURE_URL,
  collectLogs,
} from "../../helpers/app.ts";
import {
  type Answer,
  azureFetch,
  azureFixture,
  frames,
  refusal,
  stream,
} from "../../helpers/azure.ts";

const KEY = "azure-test-key-that-must-not-leak";
const row: ProviderRow = {
  id: "az1",
  name: "foundry",
  wire: "azure",
  baseUrl: AZURE_URL,
  keyName: "provider-azure",
  createdAt: 0,
};

const BLOB = "gAAAA-encrypted";
const tool = {
  name: "weather",
  description: "Get weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" }, days: { type: "integer" } },
    required: ["city"],
  },
};

// a history with every shape: system, a named user, a work reply with
// two reasoning records (one without a blob), a commentary phase, text
// and a call, its result, then an answer
const request: ChatRequest = {
  model: "gpt-6-luna",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "weather in Y?", name: "ana" },
    {
      role: "assistant",
      model: "gpt-6-luna",
      content: "Checking.",
      reasoning: "think about Y",
      reasoningDetails: [
        {
          type: "reasoning",
          index: 0,
          summary: [{ type: "summary_text", text: "think about Y" }],
          encrypted_content: BLOB,
        },
        { type: "reasoning", index: 1, summary: [] },
        { type: "phase", index: 2, phase: "commentary" },
      ],
      toolCalls: [{ id: "call_1", name: "weather", arguments: '{"city":"Y"}' }],
    },
    { role: "tool", toolCallId: "call_1", content: '{"temp_c":14}' },
    { role: "assistant", content: "It is 14 C." },
    { role: "user", content: "thanks" },
  ],
  thinking: false,
  cacheKey: "session-1",
  tools: [tool],
};

async function run(
  answers: Answer[],
  req: ChatRequest = request,
  noneRefused = new Set<string>(),
  logs = collectLogs(),
) {
  const fake = azureFetch();
  fake.queue.push(...answers);
  const provider = providerFor(row, {
    fetcher: fake.fetcher,
    secret: () => KEY,
    noneRefused,
    log: logs.logFactory("providers"),
  });
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(req, new AbortController().signal)) {
    events.push(event);
  }
  return { events, fake, logs };
}

const of = <K extends ChatEvent["kind"]>(events: ChatEvent[], kind: K) =>
  events.filter((e): e is Extract<ChatEvent, { kind: K }> => e.kind === kind);
const reasoningText = (events: ChatEvent[]) =>
  of(events, "reasoning")
    .map((e) => e.text)
    .join("");
const contentText = (events: ChatEvent[]) =>
  of(events, "content")
    .map((e) => e.text)
    .join("");

describe("the azure wire", () => {
  test("is a wire whose levels are what Azure lists", () => {
    expect(isWire("azure")).toBe(true);
    expect(EFFORTS.azure).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(isEffort("azure", "minimal")).toBe(false);
  });

  test("takes a resource's v1 address on either host and nothing else", () => {
    for (const ok of [
      "https://one.example/openai/v1",
      "https://two.example/openai/v1/",
      "https://two.example/openai/v1//",
    ]) {
      expect(azureBaseUrlProblem(ok)).toBeNull();
    }
    for (const bad of [
      "http://one.example/openai/v1",
      "https://one.example/openai",
      "https://one.example/v1",
      "https://one.example/openai/v1/responses",
      "https://one.example/openai/deployments/x",
      "not a url",
    ]) {
      expect(azureBaseUrlProblem(bad)).toContain("/openai/v1");
    }
  });

  describe("the body", () => {
    test("is the Responses body with no ids, the records projected", () => {
      expect(buildChatBody(request)).toEqual({
        model: "gpt-6-luna",
        input: [
          { role: "system", content: "be brief" },
          {
            role: "user",
            content: [{ type: "input_text", text: "[ana] weather in Y?" }],
          },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "think about Y" }],
            encrypted_content: BLOB,
          },
          {
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking." }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "weather",
            arguments: '{"city":"Y"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: '{"temp_c":14}',
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "It is 14 C." }],
          },
          { role: "user", content: [{ type: "input_text", text: "thanks" }] },
        ],
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { summary: "auto" },
        tools: [{ type: "function", ...tool, strict: false }],
        prompt_cache_key: "session-1",
      });
    });

    test("a reply of calls alone sends no message, and sampling goes only when set", () => {
      const body = buildChatBody({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "c", name: "datetime", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "c", content: "noon" },
        ],
        thinking: false,
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 128,
      });
      expect(body.input).toEqual([
        {
          type: "function_call",
          call_id: "c",
          name: "datetime",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c", output: "noon" },
      ]);
      expect(body).toMatchObject({
        temperature: 0.2,
        top_p: 0.9,
        max_output_tokens: 128,
      });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(buildChatBody(request)).not.toHaveProperty("max_output_tokens");
      expect(buildChatBody(request)).not.toHaveProperty("temperature");
    });

    test("thinking: an effort, Off and the least as none, the default the model's own", () => {
      const reasoning = (fields: Partial<ChatRequest>, noneAsLow = false) =>
        buildChatBody({ ...request, ...fields }, { noneAsLow }).reasoning;
      expect(reasoning({ thinking: true, reasoningEffort: "xhigh" })).toEqual({
        effort: "xhigh",
        summary: "auto",
      });
      expect(reasoning({ thinkingOff: true })).toEqual({ effort: "none" });
      expect(reasoning({ least: true })).toEqual({ effort: "none" });
      expect(reasoning({})).toEqual({ summary: "auto" });
      expect(reasoning({ thinking: true })).toEqual({ summary: "auto" });
      // a model that refused none gets the least thinking instead
      expect(reasoning({ least: true }, true)).toEqual({
        effort: "low",
        summary: "auto",
      });
      // the least on a model that always thinks is the wire's least effort
      expect(
        reasoning({ thinking: true, least: true, reasoningEffort: "low" }),
      ).toEqual({ effort: "low", summary: "auto" });
    });

    test("drops the reasoning records when asked, keeping the phase", () => {
      const input = buildChatBody(request, { dropReasoning: true })
        .input as Record<string, unknown>[];
      expect(input.some((item) => item.type === "reasoning")).toBe(false);
      expect(input).toContainEqual({
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking." }],
      });
    });
  });

  describe("the stream", () => {
    test("a reasoning round streams its summaries apart and ends in a call", async () => {
      const { events, fake } = await run([stream("chat-reasoning-tool.sse")]);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.url).toBe(AZURE_CHAT);
      expect(fake.calls[0]!.headers["api-key"]).toBe(KEY);
      expect(fake.calls[0]!.headers).not.toHaveProperty("authorization");
      // the summaries as sent, each part apart from the last
      const text = reasoningText(events);
      expect(text).toStartWith("**Discovering prime triplets**\n\nI'm working");
      expect(text).toContain(
        "along the way.\n\n**Checking number properties**\n\nI’m examining",
      );
      const details = of(events, "reasoningDetail").map((e) => e.item);
      // the stored summary is as Azure sent it
      expect(
        (details[0]!.summary as { text: string }[]).map((s) =>
          s.text.slice(0, 30),
        ),
      ).toEqual([
        "**Discovering prime triplets**",
        "**Checking number properties**",
      ]);
      expect(details.map((d) => [d.type, d.index])).toEqual([
        ["reasoning", 0],
        ["reasoning", 1],
        ["reasoning", 2],
      ]);
      expect(details[0]!.summary).toHaveLength(2);
      expect(details[1]!.summary).toEqual([]);
      for (const detail of details) {
        expect(typeof detail.encrypted_content).toBe("string");
        expect(detail).not.toHaveProperty("id");
      }
      expect(of(events, "toolCalls")).toEqual([
        {
          kind: "toolCalls",
          calls: [
            {
              id: "call_G61W63zk1acEY58UfBijDIH4",
              name: "weather",
              arguments: '{"city":"Y, France"}',
            },
          ],
        },
      ]);
      expect(of(events, "toolCallDelta")[0]).toMatchObject({
        index: 3,
        id: "call_G61W63zk1acEY58UfBijDIH4",
        name: "weather",
        callIndex: 0,
      });
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "tool_calls", details: null },
      ]);
      expect(of(events, "usage")).toEqual([
        {
          kind: "usage",
          usage: {
            promptTokens: 99,
            completionTokens: 1197,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 1176,
            cost: null,
          },
        },
      ]);
      expect(of(events, "error")).toEqual([]);
    });

    test("summary deltas stream as sent, a blank line between parts", async () => {
      const delta = (summary_index: number, d: string, output_index = 0) => ({
        type: "response.reasoning_summary_text.delta",
        output_index,
        summary_index,
        delta: d,
      });
      const { events } = await run([
        frames(
          delta(0, "*"),
          delta(0, "*Plan"),
          delta(0, "ning**\n\nUse **bold** here."),
          delta(1, "*"),
          { type: "response.reasoning_summary_part.done", output_index: 0 },
          delta(0, "Next item.", 1),
          { type: "response.completed", response: { status: "completed" } },
        ),
      ]);
      expect(reasoningText(events)).toBe(
        "**Planning**\n\nUse **bold** here.\n\n*\n\nNext item.",
      );
    });

    test("a commentary before a call is content and a phase record", async () => {
      const { events } = await run([stream("chat-commentary-tool.sse")]);
      expect(contentText(events)).toStartWith("For primes larger than 5");
      expect(
        of(events, "reasoningDetail")
          .map((e) => e.item)
          .filter((item) => item.type === "phase"),
      ).toEqual([{ type: "phase", index: 2, phase: "commentary" }]);
      expect(of(events, "toolCalls")[0]!.calls).toEqual([
        {
          id: "call_hSvkCYCsBl3Wldw28RRRVtNu",
          name: "weather",
          arguments: '{"city":"Bucharest"}',
        },
      ]);
      expect(of(events, "finish")[0]).toMatchObject({ reason: "tool_calls" });
    });

    test("an answer after a tool stops with its final phase", async () => {
      const { events } = await run([stream("chat-text-after-tool.sse")]);
      expect(contentText(events)).toStartWith("Since \\(p>1000\\)");
      expect(of(events, "reasoningDetail").at(-1)!.item).toEqual({
        type: "phase",
        index: 3,
        phase: "final_answer",
      });
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "stop", details: null },
      ]);
      expect(of(events, "usage")[0]!.usage).toMatchObject({
        promptTokens: 1316,
        cachedTokens: 0,
      });
    });

    test("parallel calls come out in order, whole", async () => {
      const { events } = await run([stream("chat-parallel-calls.sse")]);
      expect(of(events, "toolCalls")[0]!.calls).toEqual([
        {
          id: "call_1KiKPvXIiPHGYgPX1nAtkOEB",
          name: "weather",
          arguments: '{"city":"Bucharest"}',
        },
        {
          id: "call_RoEDE1TBAixV2jbQQ5IOPSXi",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
        {
          id: "call_f3XLAEtq5rrXei4HpoqvRUL9",
          name: "list_issues",
          arguments:
            '{"owner":"stefanprodan","repo":"1ctx","state":"open","labels":["bug"],"perPage":5,"page":1}',
        },
      ]);
    });

    test("a cut response is length, with or without text", async () => {
      const reasoningOnly = await run([
        stream("incomplete-reasoning-only.sse"),
      ]);
      expect(contentText(reasoningOnly.events)).toBe("");
      expect(of(reasoningOnly.events, "finish")).toEqual([
        { kind: "finish", reason: "length", details: null },
      ]);
      expect(of(reasoningOnly.events, "usage")[0]!.usage).toMatchObject({
        promptTokens: 15,
        completionTokens: 40,
        reasoningTokens: 40,
      });
      const short = await run([stream("incomplete-short-text.sse")]);
      expect(contentText(short.events)).toBe(
        "The discussion covered:\n- **Three deploys**\n- **Two",
      );
      expect(of(short.events, "finish")[0]).toMatchObject({ reason: "length" });
    });

    test("the item's whole arguments replace what the deltas built", async () => {
      const call = {
        type: "function_call",
        call_id: "call_x",
        name: "weather",
        arguments: "",
      };
      const { events } = await run([
        frames(
          { type: "response.output_item.added", output_index: 0, item: call },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: '{"city":"Pa',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { ...call, arguments: '{"city":"Paris"}' },
          },
          { type: "response.completed", response: { status: "completed" } },
        ),
      ]);
      expect(of(events, "toolCalls")[0]!.calls).toEqual([
        { id: "call_x", name: "weather", arguments: '{"city":"Paris"}' },
      ]);
      expect(of(events, "toolCallDone" as ChatEvent["kind"])).toEqual([]);
    });

    test("a refusal reads as content with refusal as the details", async () => {
      const { events } = await run([
        frames(
          {
            type: "response.refusal.delta",
            output_index: 0,
            delta: "I can't help with that.",
          },
          { type: "response.completed", response: { status: "completed" } },
        ),
      ]);
      expect(contentText(events)).toBe("I can't help with that.");
      expect(of(events, "finish")).toEqual([
        { kind: "finish", reason: "stop", details: "refusal" },
      ]);
    });

    test("other reasons: a filter, and a reason with no word of ours", async () => {
      const ended = async (reason: string) =>
        of(
          (
            await run([
              frames({
                type: "response.incomplete",
                response: { incomplete_details: { reason } },
              }),
            ])
          ).events,
          "finish",
        );
      expect(await ended("content_filter")).toEqual([
        { kind: "finish", reason: "content_filter", details: null },
      ]);
      expect(await ended("something_new")).toEqual([
        { kind: "finish", reason: "stop", details: "something_new" },
      ]);
    });

    test("the terminal event ends the read with no [DONE]", async () => {
      // a body that never closes after the terminal event
      const encoder = new TextEncoder();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(azureFixture("incomplete-short-text.sse")),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const provider = providerFor(row, {
        fetcher: (async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          })) as unknown as typeof fetch,
        secret: () => KEY,
      });
      const events: ChatEvent[] = [];
      for await (const event of provider.chat(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
      expect(of(events, "finish")).toHaveLength(1);
      expect(of(events, "error")).toEqual([]);
      expect(cancelled).toBe(true);
    });

    test("a failed response and an error frame are the provider's words, with the code", async () => {
      const failed = await run([
        frames({
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "server_error", message: "try again" },
          },
        }),
      ]);
      expect(of(failed.events, "error")[0]).toEqual({
        kind: "error",
        message: "server_error: try again",
        remote: true,
        code: "server_error",
      });
      const error = await run([
        frames({
          type: "error",
          code: "rate_limit_exceeded",
          message: "slow down",
          param: null,
        }),
      ]);
      expect(of(error.events, "error")[0]).toMatchObject({
        message: "rate_limit_exceeded: slow down",
        remote: true,
        code: "rate_limit_exceeded",
      });
    });
  });

  describe("the errors", () => {
    test("a refused request is its code and message, the status and the field", async () => {
      const unauthorized = await run([refusal("error-401.json", 401)]);
      expect(unauthorized.events).toHaveLength(1);
      expect(unauthorized.events[0]).toMatchObject({
        kind: "error",
        status: 401,
        remote: true,
        code: "401",
      });
      expect(of(unauthorized.events, "error")[0]!.message).toStartWith(
        "401: Access denied",
      );
      const missing = await run([refusal("error-404-deployment.json", 404)]);
      expect(missing.events[0]).toMatchObject({
        status: 404,
        code: "DeploymentNotFound",
      });
      expect(of(missing.events, "error")[0]!.message).toStartWith(
        "DeploymentNotFound: The API deployment",
      );
      const param = await run([refusal("error-param.json")]);
      expect(param.fake.calls).toHaveLength(1);
      expect(param.events[0]).toEqual({
        kind: "error",
        message:
          "Unsupported parameter: 'temperature' is not supported with this model.",
        status: 400,
        remote: true,
        param: "temperature",
      });
    });

    test("the key never rides in an error", async () => {
      const { events } = await run([
        { status: 400, body: `{"error":{"code":"x","message":"bad ${KEY}"}}` },
      ]);
      expect(of(events, "error")[0]!.message).toBe("x: bad [key]");
    });
  });

  describe("the adaptations", () => {
    const off: ChatRequest = { ...request, thinkingOff: true };
    const effortOf = (body: Record<string, any>) => body.reasoning?.effort;

    test("none refused is sent again at low and remembered for the model", async () => {
      const memo = new Set<string>();
      const first = await run(
        [refusal("error-effort-none.json"), stream("chat-text-after-tool.sse")],
        off,
        memo,
      );
      expect(first.fake.bodies().map(effortOf)).toEqual(["none", "low"]);
      expect(of(first.events, "error")).toEqual([]);
      expect(of(first.events, "finish")).toHaveLength(1);
      expect(first.logs.events).toEqual([
        {
          level: "info",
          area: "providers",
          msg: "reasoning effort raised",
          fields: { provider: "foundry", model: "gpt-6-luna" },
        },
      ]);
      // a later round pays no second refusal; another model still asks
      const later = await run([stream("chat-text-after-tool.sse")], off, memo);
      expect(later.fake.bodies().map(effortOf)).toEqual(["low"]);
      const other = await run(
        [stream("chat-text-after-tool.sse")],
        { ...off, model: "gpt-6.1-sol" },
        memo,
      );
      expect(other.fake.bodies().map(effortOf)).toEqual(["none"]);
    });

    test("a second refusal of none is the round's error", async () => {
      const { events, fake } = await run(
        [refusal("error-effort-none.json"), refusal("error-effort-none.json")],
        off,
      );
      expect(fake.bodies().map(effortOf)).toEqual(["none", "low"]);
      expect(of(events, "error")).toHaveLength(1);
      expect(of(events, "error")[0]).toMatchObject({
        status: 400,
        code: "unsupported_value",
        param: "reasoning.effort",
      });
    });

    test("none refused with an effort sent is not adapted", async () => {
      const { fake, events } = await run([refusal("error-effort-none.json")], {
        ...request,
        thinking: true,
        reasoningEffort: "high",
      });
      expect(fake.bodies()).toHaveLength(1);
      expect(of(events, "error")).toHaveLength(1);
    });

    test("a refused blob is sent again without reasoning, once", async () => {
      const { events, fake, logs } = await run([
        refusal("error-encrypted.json"),
        stream("chat-text-after-tool.sse"),
      ]);
      const [sent, again] = fake.bodies();
      const reasoningItems = (body: Record<string, any>) =>
        body.input.filter(
          (item: { type?: string }) => item.type === "reasoning",
        );
      expect(reasoningItems(sent!)).toHaveLength(1);
      expect(reasoningItems(again!)).toEqual([]);
      expect(again!.input).toContainEqual({
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking." }],
      });
      expect(events[0]).toEqual({ kind: "reasoningRefused" });
      expect(of(events, "error")).toEqual([]);
      expect(logs.events.map((event) => [event.level, event.msg])).toEqual([
        ["warn", "stored reasoning dropped"],
      ]);

      const twice = await run([
        refusal("error-encrypted.json"),
        refusal("error-encrypted.json"),
      ]);
      expect(twice.fake.bodies()).toHaveLength(2);
      expect(twice.events.map((event) => event.kind)).toEqual([
        "reasoningRefused",
        "error",
      ]);
    });

    test("both refusals in one round make three requests at most", async () => {
      const { events, fake } = await run(
        [
          refusal("error-effort-none.json"),
          refusal("error-encrypted.json"),
          refusal("error-effort-none.json"),
        ],
        off,
      );
      const bodies = fake.bodies();
      expect(bodies.map(effortOf)).toEqual(["none", "low", "low"]);
      expect(
        bodies.map(
          (body) =>
            body.input.filter(
              (item: { type?: string }) => item.type === "reasoning",
            ).length,
        ),
      ).toEqual([1, 1, 0]);
      expect(events.map((event) => event.kind)).toEqual([
        "reasoningRefused",
        "error",
      ]);
    });

    test("a blob refused when none was sent back is the round's error", async () => {
      const { events, fake } = await run([refusal("error-encrypted.json")], {
        ...request,
        messages: request.messages.slice(0, 2),
      });
      expect(fake.bodies()).toHaveLength(1);
      expect(events.map((event) => event.kind)).toEqual(["error"]);
    });
  });

  describe("the catalog", () => {
    test("is the resource's succeeded deployments, undescribed", async () => {
      const fake = azureFetch();
      const models = await fetchCatalog(fake.fetcher, row, KEY);
      expect(fake.calls[0]!.url).toBe(AZURE_DEPLOYMENTS);
      expect(fake.calls[0]!.headers["api-key"]).toBe(KEY);
      expect(models.map((m) => [m.id, m.name, m.described])).toEqual([
        ["gpt-6-luna", "gpt-6-luna", false],
        ["gpt-6.1-sol", "gpt-6.1-sol", false],
      ]);
      const parsed = parseDeployments(
        JSON.parse(azureFixture("deployments.json")),
      );
      expect(parsed[0]).toMatchObject({
        contextLength: null,
        tools: false,
        reasoning: false,
        reasoningKnown: false,
        listedAs: "gpt-6-luna",
      });
      expect(models).toEqual(parsed.map((m) => withModelsDev(m, "azure")));
    });

    test("names the model beside a deployment named otherwise, and skips one not ready", () => {
      const body = JSON.parse(azureFixture("deployments.json"));
      body.data[0].id = "luna-prod";
      body.data[1].status = "creating";
      expect(
        parseDeployments(body).map((m) => ({ id: m.id, name: m.name })),
      ).toEqual([{ id: "luna-prod", name: "luna-prod (gpt-6-luna)" }]);
    });

    test("a further page is an error, never a cut", () => {
      const body = JSON.parse(azureFixture("deployments.json"));
      expect(() => parseDeployments({ ...body, has_more: true })).toThrow(
        CatalogError,
      );
      expect(() =>
        parseDeployments({ ...body, next_link: "https://x.example/next" }),
      ).toThrow(CatalogError);
    });
  });

  describe("the count", () => {
    test("a reasoning record counts its summary, never its blob", () => {
      const blob = "x".repeat(4000);
      const withBlob: ChatRequest = {
        ...request,
        messages: request.messages.map((message) =>
          message.role === "assistant" && message.reasoningDetails
            ? {
                ...message,
                reasoningDetails: message.reasoningDetails.map((record) =>
                  record.type === "reasoning" && record.encrypted_content
                    ? { ...record, encrypted_content: blob }
                    : record,
                ),
              }
            : message,
        ),
      };
      const counted = requestTokens("azure", withBlob);
      expect(counted).toBe(requestTokens("azure", request));
      expect(counted).toBeLessThan(tokens(blob));
      // the summary text is counted
      expect(counted).toBeGreaterThan(
        requestTokens("azure", {
          ...request,
          messages: request.messages.filter((m) => m.role !== "assistant"),
        }),
      );
    });

    test("the tools count as Responses tool objects", () => {
      expect(wireTokens([tool], "azure")).toBe(
        tokens(JSON.stringify([{ type: "function", ...tool, strict: false }])),
      );
      expect(wireTokens([tool])).toBe(
        tokens(JSON.stringify([{ type: "function", function: tool }])),
      );
      expect(wireTokens([], "azure")).toBe(0);
    });
  });
});
