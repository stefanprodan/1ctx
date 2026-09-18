// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Gemini wire, Google AI Studio: the native model list for the
// catalog, and the OpenAI-compatible chat endpoint with Gemini's rules
// over the plain wire. Google refuses any body field it does not know,
// takes thinking as thinking_config or reasoning_effort none, never
// both, streams thoughts as content frames marked thought, and puts a
// thought signature on every tool call that Gemini 3 wants back on the
// next request. Verified live on 2026-09-16; the recorded frames are
// under test/fixtures/providers/gemini/.

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import { buildChatBody as buildOpenAiChatBody, chatEvents } from "./openai.ts";
import { CatalogError, type ChatEvent, type ChatRequest } from "./types.ts";

// These models generate something other than a chat answer, even when
// their catalog lists generateContent.
const EXCLUDED_WORDS = [
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
];

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function parseCatalog(body: unknown): CatalogMatch[] {
  const catalog = record(body);
  if (catalog.nextPageToken !== undefined) {
    throw new CatalogError("the catalog has more than a page");
  }
  if (!Array.isArray(catalog.models)) return [];
  const out: CatalogMatch[] = [];
  const seen = new Set<string>();
  for (const item of catalog.models) {
    const model = record(item);
    if (typeof model.name !== "string") continue;
    const id = model.name.replace(/^models\//, "");
    if (
      id === "" ||
      seen.has(id) ||
      !Array.isArray(model.supportedGenerationMethods) ||
      !model.supportedGenerationMethods.includes("generateContent") ||
      EXCLUDED_WORDS.some((word) => id.toLowerCase().includes(word))
    ) {
      continue;
    }
    seen.add(id);
    out.push({
      id,
      name:
        typeof model.displayName === "string" && model.displayName !== ""
          ? model.displayName
          : id,
      contextLength:
        num(model.inputTokenLimit) > 0 ? num(model.inputTokenLimit) : null,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      reasoning: model.thinking === true,
      described: true,
    });
  }
  // Google lists oldest first; the search keeps catalog order within a
  // rank, so newest first puts gemini-3.8 above 2.5 for "gem"
  return out.reverse();
}

const THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 } as const;

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req, { includeThinkingFlag: false });
  delete body.prompt_cache_key;
  delete body.reasoning_effort;
  const messages = body.messages as Record<string, unknown>[];
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    delete message.reasoning_content;
    delete message.reasoning_details;
    const source = req.messages[index]!;
    if (
      source.role !== "assistant" ||
      source.model !== req.model ||
      !Array.isArray(message.tool_calls)
    ) {
      return;
    }
    message.tool_calls.forEach((call: Record<string, unknown>, at) => {
      const signature = source.toolCalls?.[at]?.signature;
      if (signature !== undefined) {
        call.extra_content = { google: { thought_signature: signature } };
      }
    });
  });
  const model = req.model.toLowerCase();
  const level = model.includes("gemini-3");
  if (!req.thinking && !model.includes("pro")) {
    body.reasoning_effort = "none";
    return body;
  }
  const config: Record<string, unknown> = { include_thoughts: req.thinking };
  if (!req.thinking) {
    // Pro cannot disable thinking, including in a compaction round.
    if (level) config.thinking_level = "low";
    else config.thinking_budget = 128;
  } else if (req.reasoningEffort) {
    const effort = req.reasoningEffort;
    if (effort !== "low" && effort !== "medium" && effort !== "high") {
      throw new Error("unknown Gemini thinking effort");
    }
    if (level) config.thinking_level = effort;
    else config.thinking_budget = THINKING_BUDGETS[effort];
  }
  body.extra_body = { google: { thinking_config: config } };
  return body;
}

export function geminiEvents(): (json: string) => ChatEvent[] {
  let inThought = false;
  return (json) => {
    const events = chatEvents(json);
    if (events.length === 0 || events.some((event) => event.kind === "error")) {
      return events;
    }
    const body = record(JSON.parse(json));
    const choice = record(Array.isArray(body.choices) ? body.choices[0] : null);
    const delta = record(choice.delta);
    const google = record(record(delta.extra_content).google);
    const thought = google.thought === true;
    const firstThought = thought && !inThought;
    if (thought) inThought = true;
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    let callIndex = 0;
    return events.flatMap((event): ChatEvent[] => {
      if (event.kind === "content") {
        let text = event.text;
        if (thought) {
          if (firstThought) text = text.replace(/^<thought>/, "");
          return text ? [{ kind: "reasoning", text }] : [];
        }
        if (inThought) {
          text = text.replace(/^<\/thought>/, "");
          inThought = false;
        }
        return text ? [{ kind: "content", text }] : [];
      }
      if (event.kind === "toolCallDelta") {
        const call = record(calls[callIndex++]);
        const signature = record(
          record(call.extra_content).google,
        ).thought_signature;
        return [
          {
            ...event,
            ...(typeof signature === "string" ? { signature } : {}),
          },
        ];
      }
      if (event.kind === "usage") {
        const usage = record(body.usage);
        const completion = num(usage.total_tokens) - event.usage.promptTokens;
        const reasoning = completion - num(usage.completion_tokens);
        return [
          {
            kind: "usage",
            usage: {
              ...event.usage,
              completionTokens: completion,
              reasoningTokens: reasoning > 0 ? reasoning : null,
              cost: null,
            },
          },
        ];
      }
      return [event];
    });
  };
}

export function geminiError(message: string): string {
  const match = /^HTTP (\d+): (.*)$/s.exec(message);
  if (!match) return message;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[2]!);
  } catch {
    return message;
  }
  if (!Array.isArray(parsed)) return message;
  const words = parsed
    .map((item) => record(record(item).error).message)
    .filter((text): text is string => typeof text === "string" && text !== "");
  return words.length > 0 ? `Gemini ${match[1]}: ${words.join("\n")}` : message;
}
