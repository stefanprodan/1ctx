// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records the Claude API into test/fixtures/providers/anthropic/, for
// the anthropic wire's tests, with the bodies the wire itself builds:
//
//   bun scripts/record/anthropic.ts
//
// The key is read from KEY_FILE, by default staging's
// workspace/staging/secrets/provider-anthropic.key, and never printed or
// written out. It records the catalog, a Haiku 5.5 tool round with
// thinking and its continuation, two parallel calls, a cached pair,
// thinking off, a summary on Opus 5.5, a 401 and a max_tokens end; a
// few cents in all.

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildChatBody } from "../../src/server/providers/anthropic.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ChatTool,
} from "../../src/server/providers/types.ts";
import { ANTHROPIC_VERSION } from "../../src/server/providers/wires.ts";
import { SUMMARIZE } from "../../src/server/runner/context.ts";

const BASE = "https://api.anthropic.com/v1";
const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "test", "fixtures", "providers", "anthropic");
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";

const keyFile =
  process.env.KEY_FILE ??
  join(ROOT, "workspace", "staging", "secrets", "provider-anthropic.key");
const key = readFileSync(keyFile, "utf8").trim();

const scrub = (text: string) => text.replaceAll(key, "[key]");

async function save(name: string, body: string): Promise<void> {
  let text = scrub(body);
  if (name.endsWith(".json")) {
    try {
      text = `${JSON.stringify(JSON.parse(text), null, 1)}\n`;
    } catch {}
  }
  await writeFile(join(OUT, name), text);
  console.log(`${name} written, ${text.length} bytes`);
}

const headers = (apiKey = key) => ({
  "x-api-key": apiKey,
  "anthropic-version": ANTHROPIC_VERSION,
  "content-type": "application/json",
});

// one request as the wire sends it; the raw answer is the fixture
async function record(
  name: string,
  req: ChatRequest,
  keyed = key,
): Promise<string> {
  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: headers(keyed),
    body: JSON.stringify(buildChatBody(req)),
  });
  const text = await res.text();
  console.log(`${name}: ${res.status}`);
  await save(name, text);
  return text;
}

type Block = Record<string, any>;

// the reply's blocks from a stream, as the next request sends them back
function blocksOf(sse: string): Block[] {
  const blocks: Block[] = [];
  const json: string[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const ev = JSON.parse(line.slice(5));
    if (ev.type === "content_block_start") {
      blocks[ev.index] = { ...ev.content_block };
      json[ev.index] = "";
    }
    if (ev.type !== "content_block_delta") continue;
    const b = blocks[ev.index]!;
    const d = ev.delta;
    if (d.type === "text_delta") b.text += d.text;
    if (d.type === "thinking_delta") b.thinking += d.thinking;
    if (d.type === "signature_delta") b.signature += d.signature;
    if (d.type === "input_json_delta") json[ev.index] += d.partial_json;
  }
  blocks.forEach((b, i) => {
    if (b.type === "tool_use") b.input = json[i] ? JSON.parse(json[i]!) : {};
  });
  return blocks;
}

// the stored shape of a reply: its thinking records, text and calls
function assistantOf(model: string, blocks: Block[]): ChatMessageIn {
  return {
    role: "assistant",
    model,
    content: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
    reasoningDetails: blocks.flatMap((b, index) =>
      b.type === "thinking"
        ? [
            {
              type: "thinking",
              index,
              thinking: b.thinking,
              signature: b.signature,
            },
          ]
        : [],
    ),
    toolCalls: blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      })),
  };
}

const getTime: ChatTool = {
  name: "get_time",
  description: "Current UTC time in a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};
const add: ChatTool = {
  name: "add",
  description: "Add two integers.",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
  },
};

const ask = (content: string): ChatMessageIn => ({ role: "user", content });
const system = (content: string): ChatMessageIn => ({
  role: "system",
  content,
});

// the catalog
{
  const res = await fetch(`${BASE}/models?limit=1000`, { headers: headers() });
  console.log(`models: ${res.status}`);
  await save("models.json", await res.text());
}

// a tool round that thinks, and its continuation with the result
{
  const question = ask(
    "What time is it in Bucharest? Use the tool, then say whether DST applies.",
  );
  const req: ChatRequest = {
    model: HAIKU,
    thinking: true,
    reasoningEffort: "high",
    messages: [system("Be brief."), question],
    tools: [getTime],
  };
  const round = await record("chat-tool-round.sse", req);
  const reply = assistantOf(HAIKU, blocksOf(round));
  const call = reply.role === "assistant" ? reply.toolCalls?.[0] : undefined;
  if (call) {
    await record("chat-tool-result.sse", {
      ...req,
      messages: [
        ...req.messages,
        reply,
        { role: "tool", toolCallId: call.id, content: "2026-10-09T09:12:00Z" },
      ],
    });
  }
}

// two calls in one step
await record("chat-parallel-calls.sse", {
  model: HAIKU,
  thinking: true,
  reasoningEffort: "high",
  messages: [
    ask("Add 12 and 30, and 7 and 8, with one add call each, both at once."),
  ],
  tools: [add],
});

// a cached pair: the same long prefix written, then read
{
  const docs = ["providers.md", "sessions.md"]
    .map((name) => readFileSync(join(ROOT, "docs", name), "utf8"))
    .join("\n\n");
  const req: ChatRequest = {
    model: HAIKU,
    thinking: false,
    messages: [
      system(docs),
      ask("In one sentence: which wires get past reasoning back?"),
    ],
  };
  await record("chat-cached-write.sse", req);
  await record("chat-cached-read.sse", req);
}

// thinking off
await record("chat-thinking-off.sse", {
  model: HAIKU,
  thinking: false,
  thinkingOff: true,
  messages: [ask("Say ok.")],
});

// a summary on a model that always thinks: the least thinking, low
await record("chat-summary-opus.sse", {
  model: OPUS,
  thinking: true,
  least: true,
  reasoningEffort: "low",
  maxTokens: 1024,
  messages: [
    system("Be brief."),
    ask("What time is it in Bucharest?"),
    { role: "assistant", content: "It is 12:12 EEST on 2026-10-09." },
    ask(SUMMARIZE),
  ],
});

// a reply cut by its cap
await record("chat-max-tokens.sse", {
  model: HAIKU,
  thinking: false,
  maxTokens: 16,
  messages: [ask("List the first fifty primes, one per line.")],
});

// a refused key: free
await record(
  "error-401.json",
  { model: HAIKU, thinking: false, messages: [ask("hi")] },
  "sk-ant-invalid",
);

// max_tokens missing: free
{
  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: HAIKU, messages: [ask("hi")] }),
  });
  console.log(`error-no-max-tokens: ${res.status}`);
  await save("error-no-max-tokens.json", await res.text());
}
