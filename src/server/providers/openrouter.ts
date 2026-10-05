// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { NOT_FOUR_BIT } from "../../shared/quantization.ts";
import { frameEvents, parseFrame } from "./frames.ts";
import { baseChatBody } from "./openai.ts";
import type { ChatEvent, ChatRequest, ReasoningDetail } from "./types.ts";

export const OPENROUTER_HEADERS = {
  "http-referer": "https://1ctx.dev",
  "x-title": "1ctx",
};

// only Claude models take breakpoints: the system prompt and the last
// two turns
const CACHE_BREAKPOINTS = 2;
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

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = baseChatBody(req, { reasoningDetails: true });
  if (req.cacheKey) body.session_id = req.cacheKey;
  // order, never only: a tag that stopped serving is skipped, so the
  // preference costs a discount and never the turn
  const provider: Record<string, unknown> = {};
  if (req.upstream) provider.order = [req.upstream];
  // a filter no host of the model passes is a 404, so it is the agent's
  // choice and never a default
  if (req.skip4Bit) provider.quantizations = [...NOT_FOUR_BIT];
  if (Object.keys(provider).length > 0) body.provider = provider;
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

// a refused request's body is OpenRouter's JSON, whose upstream text is
// what the user needs
export function openRouterError(
  status: number,
  body: string,
): { message: string } {
  return { message: `OpenRouter ${status}: ${errorText(body)}` };
}
