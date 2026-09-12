// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenAI wire on hand-built frames and on the frames recorded from
// an OpenAI-compatible server (test/fixtures/providers/openai/): the
// body, the events, the tool call tracker and the stream's ends.

import { describe, expect, test } from "bun:test";
import {
  buildChatBody,
  chatEvents,
  parseSse,
  streamChat,
  ToolCallTracker,
  wireName,
} from "../../../src/server/providers/openai.ts";
import type {
  ChatEvent,
  ChatRequest,
} from "../../../src/server/providers/types.ts";

const fixture = (name: string) =>
  Bun.file(new URL(`../../fixtures/providers/openai/${name}`, import.meta.url));
const plainStream = await fixture("chat-stream.sse").text();
const toolsStream = await fixture("chat-tools.sse").text();
const lengthStream = await fixture("chat-tools-length.sse").text();

const request: ChatRequest = {
  model: "org/model",
  messages: [{ role: "user", content: "hello" }],
  thinking: false,
  temperature: null,
  topP: null,
  maxTokens: null,
};

function delta(
  fields: Omit<Extract<ChatEvent, { kind: "toolCallDelta" }>, "kind">,
): Extract<ChatEvent, { kind: "toolCallDelta" }> {
  return { kind: "toolCallDelta", ...fields };
}

// the stream behind a fetcher that answers the given text
async function streamed(
  text: string,
  status = 200,
): Promise<{ events: ChatEvent[]; init: RequestInit | undefined }> {
  let init: RequestInit | undefined;
  const fetcher = (async (_url: unknown, options?: RequestInit) => {
    init = options;
    return new Response(text, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  const events: ChatEvent[] = [];
  for await (const event of streamChat(
    fetcher,
    "http://models.test/v1/chat/completions",
    buildChatBody(request),
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return { events, init };
}

const frames = (list: object[], done = true) =>
  list.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
  (done ? "data: [DONE]\n\n" : "");

describe("OpenAI chat body", () => {
  test("maps a tool-calling history and omits empty tools", () => {
    const body = buildChatBody({
      ...request,
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "what time is it?", name: "ana" },
        {
          role: "assistant",
          content: "",
          reasoning: "I should check",
          toolCalls: [
            {
              id: "call_time",
              name: "get_current_time",
              arguments: '{"timezone":"UTC"}',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_time",
          content: '{"datetime":"2026-09-08T15:00:00Z"}',
        },
      ],
      tools: [],
      temperature: 0,
      topP: 0.8,
      maxTokens: 100,
    });
    expect(body).toEqual({
      model: "org/model",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "what time is it?", name: "ana" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "I should check",
          tool_calls: [
            {
              id: "call_time",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: '{"timezone":"UTC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_time",
          content: '{"datetime":"2026-09-08T15:00:00Z"}',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      top_p: 0.8,
      max_tokens: 100,
    });
    expect(body).not.toHaveProperty("tools");
  });

  test("a user message without an author has no name field", () => {
    expect(buildChatBody(request).messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("an author's name is made what the wire accepts", () => {
    expect(wireName("stefan.prodan")).toBe("stefan_prodan");
    expect(wireName("Ana Maria")).toBe("Ana_Maria");
    expect(wireName("x".repeat(70))).toHaveLength(64);
    expect(wireName("")).toBeNull();
    expect(
      buildChatBody({
        ...request,
        messages: [{ role: "user", content: "hi", name: "a.b" }],
      }).messages,
    ).toEqual([{ role: "user", content: "hi", name: "a_b" }]);
  });

  test("sends the cache key as prompt_cache_key only when set", () => {
    expect(buildChatBody(request)).not.toHaveProperty("prompt_cache_key");
    expect(buildChatBody({ ...request, cacheKey: null })).not.toHaveProperty(
      "prompt_cache_key",
    );
    expect(
      buildChatBody({ ...request, cacheKey: "session-1" }).prompt_cache_key,
    ).toBe("session-1");
  });

  test("maps non-empty tools to OpenAI function schemas", () => {
    expect(
      buildChatBody({
        ...request,
        tools: [
          {
            name: "clock",
            description: "Read a clock",
            parameters: { type: "object", properties: {} },
          },
        ],
      }).tools,
    ).toEqual([
      {
        type: "function",
        function: {
          name: "clock",
          description: "Read a clock",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("OpenAI chat events", () => {
  test("maps content, reasoning, optional tool fields and finish", () => {
    expect(
      chatEvents(
        JSON.stringify({
          choices: [
            {
              delta: {
                content: null,
                reasoning_content: "think",
                tool_calls: [
                  { function: { arguments: "{" } },
                  { index: 2, id: "two", function: { name: "clock" } },
                ],
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    ).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "toolCallDelta", arguments: "{" },
      { kind: "toolCallDelta", index: 2, id: "two", name: "clock" },
      { kind: "finish", reason: "stop", details: null },
    ]);
  });

  test("maps usage with what the server said and null for the rest", () => {
    expect(
      chatEvents(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 7 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
      ),
    ).toEqual([
      {
        kind: "usage",
        usage: {
          promptTokens: 12,
          completionTokens: 4,
          cachedTokens: 7,
          reasoningTokens: 2,
          cost: null,
        },
      },
    ]);
    expect(
      chatEvents(
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.002 },
        }),
      ),
    ).toEqual([
      {
        kind: "usage",
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: null,
          reasoningTokens: null,
          cost: 0.002,
        },
      },
    ]);
  });

  test("an error frame and bad JSON are error events", () => {
    expect(chatEvents('{"error":{"message":"no such model"}}')).toEqual([
      { kind: "error", message: "no such model" },
    ]);
    expect(chatEvents("{nope")).toEqual([
      { kind: "error", message: "invalid JSON in the stream" },
    ]);
    expect(chatEvents("[DONE]")).toEqual([]);
  });
});

describe("parseSse", () => {
  test("joins data lines, drops comments and keeps the rest", () => {
    const { frames, rest } = parseSse(
      "",
      ': keep-alive\n\ndata: {"a":1}\ndata: {"b":2}\n\ndata: {"c"',
    );
    expect(frames).toEqual(['{"a":1}\n{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  test("refuses an oversized frame", () => {
    expect(() =>
      parseSse("", `data: ${"x".repeat(1024 * 1024 + 1)}\n\n`),
    ).toThrow("oversized");
  });
});

describe("ToolCallTracker", () => {
  test("joins fragmented arguments when the name arrives last", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ index: 0, arguments: '{"time' }));
    tracker.push(delta({ index: 0, arguments: 'zone":"' }));
    tracker.push(delta({ index: 0, arguments: 'UTC"}' }));
    tracker.push(delta({ id: "server_call", name: "get_current_time" }));
    expect(tracker.flush()).toEqual([
      {
        id: "server_call",
        name: "get_current_time",
        arguments: '{"timezone":"UTC"}',
      },
    ]);
  });

  test("tracks items without indexes by id and then by latest call", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ id: "first", arguments: "{" }));
    tracker.push(delta({ arguments: "}" }));
    tracker.push(delta({ id: "first", name: "one" }));
    tracker.push(delta({ id: "second", name: "two", arguments: "" }));
    expect(tracker.flush()).toEqual([
      { id: "first", name: "one", arguments: "{}" },
      { id: "second", name: "two", arguments: "" },
    ]);
  });

  test("orders sparse indexed calls and synthesises missing ids", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ index: 2, name: "later", arguments: "2" }));
    tracker.push(delta({ index: 0, name: "first", arguments: "0" }));
    expect(tracker.flush()).toEqual([
      { id: "call_0", name: "first", arguments: "0" },
      { id: "call_1", name: "later", arguments: "2" },
    ]);
  });
});

describe("OpenAI chat stream", () => {
  test("a recorded reply cut by length streams reasoning, the finish, then usage", async () => {
    const { events, init } = await streamed(plainStream);
    expect(init?.method).toBe("POST");
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "reasoning").length).toBeGreaterThan(10);
    expect(kinds.indexOf("finish")).toBeLessThan(kinds.indexOf("usage"));
    expect(
      events.some((e) => e.kind === "finish" && e.reason === "length"),
    ).toBe(true);
    expect(kinds.at(-1)).toBe("usage");
    const usage = events.at(-1) as Extract<ChatEvent, { kind: "usage" }>;
    expect(usage.usage).toEqual({
      promptTokens: 46,
      completionTokens: 80,
      cachedTokens: 0,
      reasoningTokens: null,
      cost: null,
    });
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a recorded tool call is flushed whole after the finish", async () => {
    const { events } = await streamed(toolsStream);
    const calls = events.find((e) => e.kind === "toolCalls") as Extract<
      ChatEvent,
      { kind: "toolCalls" }
    >;
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0].name).toBe("get_current_time");
    expect(JSON.parse(calls.calls[0].arguments)).toHaveProperty("timezone");
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a recorded call cut by length is still flushed", async () => {
    const { events } = await streamed(lengthStream);
    expect(
      events.some((e) => e.kind === "finish" && e.reason === "length"),
    ).toBe(true);
    expect(events.some((e) => e.kind === "toolCalls")).toBe(true);
  });

  test("flushes calls after stop without a usage chunk", async () => {
    const { events } = await streamed(
      frames([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_one",
                    function: { name: "clock", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    expect(events.at(-1)).toEqual({
      kind: "toolCalls",
      calls: [{ id: "call_one", name: "clock", arguments: "{}" }],
    });
    expect(events.some((event) => event.kind === "usage")).toBe(false);
  });

  test("flushes partial calls after length and after a later usage", async () => {
    const { events } = await streamed(
      frames([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "fetch", arguments: '{"url":' },
                  },
                ],
              },
              finish_reason: "length",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
      ]),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "toolCallDelta",
      "finish",
      "usage",
      "toolCalls",
    ]);
    expect(events.at(-1)).toEqual({
      kind: "toolCalls",
      calls: [{ id: "call_0", name: "fetch", arguments: '{"url":' }],
    });
  });

  test("flushes calls at EOF and reports a missing finish", async () => {
    const { events } = await streamed(
      frames(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ function: { name: "clock", arguments: "" } }],
                },
                finish_reason: null,
              },
            ],
          },
        ],
        false,
      ),
    );
    expect(events.slice(-2)).toEqual([
      {
        kind: "toolCalls",
        calls: [{ id: "call_0", name: "clock", arguments: "" }],
      },
      { kind: "error", message: "stream ended early" },
    ]);
  });

  test("a refused request is one error with the status and the body", async () => {
    const { events } = await streamed('{"error":"no"}', 500);
    expect(events).toEqual([
      { kind: "error", message: 'HTTP 500: {"error":"no"}' },
    ]);
  });
});
