// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenRouter wire: the OpenAI chat wire with a bearer key, the
// reasoning object in place of a thinking flag, usage with cost on the
// last frame, and the per-family message rules an upstream needs. The
// catalog half is catalog.ts.
//
// Verified on 2026-09-10 against the live API (the recorded frames under
// test/fixtures/providers/openrouter/): reasoning streams as
// delta.reasoning, tool calls in the OpenAI shape, usage rides on a
// final chunk that repeats the finish reason, keep-alive comments
// precede the first token, and a free endpoint refuses with an HTTP 429
// whose body names the upstream pool.

import {
  buildChatBody as buildOpenAiChatBody,
  frameEvents,
  parseFrame,
} from "./openai.ts";
import type { ChatEvent, ChatRequest, ReasoningDetail } from "./types.ts";

// The breakpoints an Anthropic upstream caches at: the system prompt,
// then the last two turns, so the previous turn's prefix is read while
// this turn's is written. Only Claude models get them (OpenCode's rule;
// the other upstreams cache on their own or not at all, and their wire
// stays the plain one). A breakpoint needs the content as parts.
export const CACHE_BREAKPOINTS = 2;
export function takesCacheBreakpoints(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("claude") || id.includes("anthropic");
}
export function withCacheBreakpoints(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const marked = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "system") marked.add(i);
  });
  let tail = CACHE_BREAKPOINTS;
  for (let i = messages.length - 1; i >= 0 && tail > 0; i--) {
    if (messages[i]!.role === "system") continue;
    if (typeof messages[i]!.content !== "string") continue;
    marked.add(i);
    tail--;
  }
  return messages.map((m, i) =>
    marked.has(i) && typeof m.content === "string"
      ? {
          ...m,
          content: [
            {
              type: "text",
              text: m.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : m,
  );
}

// DeepSeek refuses a history where an assistant message has no reasoning
// field at all (a turn with thinking off, or history with past reasoning
// off), so every assistant message gets an empty one when it has none.
export function withEmptyReasoning(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.map((m) =>
    m.role === "assistant" && !("reasoning" in m) && !("reasoning_details" in m)
      ? { ...m, reasoning: "" }
      : m,
  );
}

// The stream repeats each item's index on every piece: the text grows
// piece by piece and the signature lands on a late one, so pieces with
// one index and type are merged into one item, in arrival order.
export function mergeReasoningDetail(
  items: ReasoningDetail[],
  piece: ReasoningDetail,
): ReasoningDetail[] {
  const at = items.findIndex(
    (item) =>
      item.type === piece.type &&
      typeof item.index === "number" &&
      item.index === piece.index,
  );
  if (at < 0) return [...items, { ...piece }];
  const merged: ReasoningDetail = { ...items[at]! };
  for (const [field, value] of Object.entries(piece)) {
    if (
      (field === "text" || field === "summary" || field === "data") &&
      typeof value === "string" &&
      typeof merged[field] === "string"
    ) {
      merged[field] = `${merged[field]}${value}`;
    } else if (value !== null && value !== undefined && value !== "") {
      merged[field] = value;
    }
  }
  return items.map((item, i) => (i === at ? merged : item));
}

// The request body: the shared wire, reasoning as OpenRouter's object,
// usage asked for on the last frame, the session id as session_id (the
// sticky routing key: every turn goes to the upstream that holds the
// cached prefix; prompt_cache_key is only its fallback), the preferred
// upstream as provider.order and the per-family message rules above.
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req, {
    reasoningField: "reasoning",
    includeThinkingFlag: false,
  });
  delete body.prompt_cache_key;
  delete body.reasoning_effort;
  delete body.stream_options;
  if (req.cacheKey) body.session_id = req.cacheKey;
  // order, never only: a tag that stopped serving is skipped, so the
  // preference costs a discount and never the turn
  if (req.upstream) body.provider = { order: [req.upstream] };
  body.usage = { include: true };
  // no middle-out: OpenRouter would cut a long prompt to the window on
  // its own, silently, and the runner compacts from the usage it counts
  body.transforms = [];
  let messages = body.messages as Record<string, unknown>[];
  if (takesCacheBreakpoints(req.model)) {
    messages = withCacheBreakpoints(messages);
  }
  if (req.model.toLowerCase().includes("deepseek")) {
    messages = withEmptyReasoning(messages);
  }
  body.messages = messages;
  // a set effort goes through as is: the policy already dropped it when
  // thinking is off, and off is the exclude below, never an effort word
  body.reasoning = req.thinking
    ? req.reasoningEffort
      ? { effort: req.reasoningEffort }
      : { enabled: true }
    : { exclude: true, enabled: false };
  return body;
}

// The error body of a refused request, as OpenRouter writes it: the
// upstream's own words when it has them, else the message.
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    const raw = error?.metadata?.raw;
    if (typeof raw === "string" && raw !== "") return raw;
    if (typeof error?.message === "string" && error.message !== "") {
      return error.message;
    }
  } catch {}
  return body;
}

// Every frame names the upstream and the model, and every one says so:
// a round stopped or failed before its finish still knows who served it
export function openRouterEvents(json: string): ChatEvent[] {
  const body = parseFrame(json);
  if (!body.ok) return body.events;
  const events = frameEvents(body.value);
  const upstream = text(body.value?.provider);
  const model = text(body.value?.model);
  if (upstream !== null || model !== null) {
    events.push({ kind: "served", upstream, model });
  }
  return events;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// the HTTP error path joins the status and the body; the body is
// OpenRouter's JSON, whose upstream text is what the user needs
export function openRouterError(message: string): string {
  const m = /^HTTP (\d+): (.*)$/s.exec(message);
  return m ? `OpenRouter ${m[1]}: ${errorText(m[2])}` : message;
}
