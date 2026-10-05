// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every wire's request, byte for byte, against bodies.json. Regenerate
// only for an intended wire change: BODIES_WRITE=1 bun test <this file>.

import { expect, test } from "bun:test";
import { providerFor } from "../../../src/server/providers/provider.ts";
import type { ProviderRow } from "../../../src/server/providers/store.ts";
import type {
  ChatMessageIn,
  ChatRequest,
} from "../../../src/server/providers/types.ts";
import { EFFORTS, WIRES, type Wire } from "../../../src/shared/words.ts";
import { AZURE_URL } from "../../helpers/app.ts";

const FIXTURE = new URL(
  "../../fixtures/providers/bodies.json",
  import.meta.url,
);

const BASE_URL: Record<Wire, string> = {
  openrouter: "https://router.test/api/v1",
  "openai-compatible": "http://local.test/v1/",
  "openai-strict": "https://strict.test/v1",
  gemini: "https://gemini.test/v1beta",
  opencode: "https://opencode.test/zen/go/v1",
  azure: AZURE_URL,
};

const MODELS: Record<Wire, string[]> = {
  openrouter: ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-v3", "x/y"],
  "openai-compatible": ["qwen3"],
  "openai-strict": ["nvidia/nemotron"],
  gemini: ["gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"],
  opencode: ["kimi-k2", "glm-4.6"],
  azure: ["gpt-5"],
};

const history = (model: string): ChatMessageIn[] => [
  { role: "system", content: "be brief" },
  { role: "user", content: "what time is it", name: "ana.b" },
  {
    role: "assistant",
    model,
    content: "",
    reasoning: "check the clock",
    reasoningDetails: [
      { type: "reasoning.text", text: "check", index: 0, signature: "s" },
      { type: "reasoning", index: 1, summary: [], encrypted_content: "blob" },
      { type: "phase", index: 2, phase: "commentary" },
    ],
    toolCalls: [
      { id: "call_1", name: "datetime", arguments: "{}", signature: "sig" },
      { id: "call_2", name: "datetime", arguments: '{"tz":"UTC"}' },
    ],
  },
  { role: "tool", toolCallId: "call_1", content: "noon" },
  { role: "tool", toolCallId: "call_2", content: "noon UTC" },
  {
    role: "assistant",
    model: "other/model",
    content: "it is noon",
    reasoning: "said it",
    toolCalls: [{ id: "call_3", name: "datetime", arguments: "{}" }],
  },
  { role: "tool", toolCallId: "call_3", content: "noon" },
  { role: "assistant", model, content: "noon", reasoning: "" },
  { role: "user", content: "thanks" },
];

type Variant = { name: string; req: Partial<ChatRequest> };

function variants(wire: Wire): Variant[] {
  const out: Variant[] = [
    { name: "default", req: { thinking: false } },
    { name: "on", req: { thinking: true } },
    { name: "off", req: { thinking: false, thinkingOff: true } },
    { name: "least", req: { thinking: false, least: true } },
    {
      name: "full",
      req: {
        thinking: true,
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 300,
        cacheKey: "session-1",
        upstream: "fireworks",
        skip4Bit: true,
        tools: [
          {
            name: "datetime",
            description: "the clock",
            parameters: { type: "object" },
          },
        ],
      },
    },
    {
      name: "bare",
      req: {
        thinking: false,
        temperature: null,
        topP: null,
        maxTokens: null,
        cacheKey: null,
        tools: [],
      },
    },
  ];
  for (const effort of EFFORTS[wire]) {
    out.push({
      name: `effort-${effort}`,
      req: { thinking: true, reasoningEffort: effort, cacheKey: "s2" },
    });
    out.push({
      name: `effort-${effort}-off`,
      req: { thinking: false, reasoningEffort: effort, thinkingOff: true },
    });
  }
  return out;
}

async function sent(wire: Wire, req: ChatRequest) {
  const row: ProviderRow = {
    id: "p1",
    name: "p",
    wire,
    baseUrl: BASE_URL[wire],
    keyName: "provider-p",
    createdAt: 0,
  };
  let url = "";
  let init: RequestInit | undefined;
  const fetcher = (async (to: unknown, options?: RequestInit) => {
    url = String(to);
    init = options;
    return new Response("data: [DONE]\n\n");
  }) as unknown as typeof fetch;
  const provider = providerFor(row, { fetcher, secret: () => "k" });
  for await (const _ of provider.chat(req, new AbortController().signal)) {
  }
  return { url, headers: init?.headers, body: String(init?.body) };
}

async function bodies(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const wire of WIRES) {
    for (const model of MODELS[wire]) {
      for (const variant of variants(wire)) {
        const req: ChatRequest = {
          model,
          messages: history(model),
          thinking: false,
          ...variant.req,
        };
        out[`${wire} ${model} ${variant.name}`] = await sent(wire, req);
      }
    }
  }
  return out;
}

test("every wire sends the recorded request", async () => {
  const got = await bodies();
  if (process.env.BODIES_WRITE === "1") {
    await Bun.write(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
  }
  const want = await Bun.file(FIXTURE).json();
  expect(Object.keys(got)).toEqual(Object.keys(want));
  for (const [name, request] of Object.entries(want)) {
    expect({ name, ...(got[name] as object) }).toEqual({
      name,
      ...(request as object),
    });
  }
});
