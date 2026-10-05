// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import { canStopThinking } from "../../shared/thinking.ts";
import { frameEvents, num, parseFrame } from "./frames.ts";
import { baseChatBody } from "./openai.ts";
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
      thinkingRequired: false,
      reasoningKnown: true,
      described: true,
    });
  }
  // Google lists oldest first; the search keeps catalog order within a
  // rank, so newest first puts gemini-3.8 above 2.5 for "gem"
  return out.reverse();
}

const THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 } as const;

// https://ai.google.dev/gemini-api/docs/thought-signatures
export const FOREIGN_SIGNATURE = "skip_thought_signature_validator";

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = baseChatBody(req, { usageOption: true });
  const messages = body.messages as Record<string, unknown>[];
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const source = req.messages[index]!;
    if (source.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return;
    }
    const own = source.model === req.model;
    const signatures: (string | undefined)[] = message.tool_calls.map(
      (_call, at) => (own ? source.toolCalls?.[at]?.signature : undefined),
    );
    // Gemini 3 refuses a step whose first call has no signature, as
    // another model's calls or older rows have; Google's placeholder for
    // calls it did not make goes on that first call, and Gemini's own
    // signatures stay as they came
    if (!signatures.some((signature) => signature !== undefined)) {
      signatures[0] = FOREIGN_SIGNATURE;
    }
    message.tool_calls.forEach((call: Record<string, unknown>, at) => {
      const signature = signatures[at];
      if (signature !== undefined) {
        call.extra_content = { google: { thought_signature: signature } };
      }
    });
  });
  const model = req.model.toLowerCase();
  const level = model.includes("gemini-3");
  if (!req.thinking && canStopThinking("gemini", req.model)) {
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
    const frame = parseFrame(json);
    if (!frame.ok) return frame.events;
    const events = frameEvents(frame.value);
    if (events.length === 0 || events.some((event) => event.kind === "error")) {
      return events;
    }
    const body = record(frame.value);
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

// Google's own words from a refused request's body, or null without them
export function geminiError(
  status: number,
  body: string,
): { message: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const words = parsed
    .map((item) => record(record(item).error).message)
    .filter((text): text is string => typeof text === "string" && text !== "");
  return words.length > 0
    ? { message: `Gemini ${status}: ${words.join("\n")}` }
    : null;
}
