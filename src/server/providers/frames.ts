// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One SSE frame of the OpenAI chat wire as ChatEvents: the reasoning,
// the content, the tool call fragments, the finish and the usage. A
// wire with more in its frames parses once and adds its own events.

import type { ChatEvent, ReasoningDetail } from "./types.ts";

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function chatEvents(json: string): ChatEvent[] {
  const body = parseFrame(json);
  return body.ok ? frameEvents(body.value) : body.events;
}

// one frame's JSON, or the events that stand for it: none for [DONE],
// an error for text that is not JSON
export function parseFrame(
  json: string,
): { ok: true; value: any } | { ok: false; events: ChatEvent[] } {
  if (json.trim() === "[DONE]") return { ok: false, events: [] };
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return {
      ok: false,
      events: [{ kind: "error", message: "invalid JSON in the stream" }],
    };
  }
}

export function frameEvents(body: any): ChatEvent[] {
  if (body?.error) {
    const message =
      typeof body.error.message === "string"
        ? body.error.message
        : typeof body.error === "string"
          ? body.error
          : "the provider failed";
    return [{ kind: "error", message }];
  }
  const events: ChatEvent[] = [];
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const delta = choice?.delta;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ kind: "reasoning", text: delta.reasoning_content });
  } else if (typeof delta?.reasoning === "string" && delta.reasoning) {
    // OpenRouter's name for the same delta; reasoning_details below
    // carries the structured form the next request sends back
    events.push({ kind: "reasoning", text: delta.reasoning });
  }
  if (Array.isArray(delta?.reasoning_details)) {
    for (const item of delta.reasoning_details) {
      if (typeof item?.type === "string") {
        events.push({ kind: "reasoningDetail", item: item as ReasoningDetail });
      }
    }
  }
  if (typeof delta?.content === "string" && delta.content) {
    events.push({ kind: "content", text: delta.content });
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const item of delta.tool_calls) {
      const event: Extract<ChatEvent, { kind: "toolCallDelta" }> = {
        kind: "toolCallDelta",
      };
      if (typeof item?.index === "number") event.index = item.index;
      if (typeof item?.id === "string") event.id = item.id;
      if (typeof item?.function?.name === "string") {
        event.name = item.function.name;
      }
      if (typeof item?.function?.arguments === "string") {
        event.arguments = item.function.arguments;
      }
      events.push(event);
    }
  }
  if (typeof choice?.finish_reason === "string") {
    const finish: Extract<ChatEvent, { kind: "finish" }> = {
      kind: "finish",
      reason: choice.finish_reason,
      details:
        typeof choice.finish_details?.type === "string"
          ? choice.finish_details.type
          : null,
    };
    if (
      typeof choice.native_finish_reason === "string" &&
      choice.native_finish_reason !== ""
    ) {
      finish.native = choice.native_finish_reason;
    }
    events.push(finish);
  }
  // the usage chunk: choices empty on an OpenAI-shaped server, one
  // content-free choice repeating the finish on OpenRouter
  if (body?.usage && typeof body.usage === "object") {
    const usage = body.usage;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    events.push({
      kind: "usage",
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        cachedTokens: typeof cached === "number" ? cached : null,
        reasoningTokens: typeof reasoning === "number" ? reasoning : null,
        cost: typeof usage.cost === "number" ? usage.cost : null,
      },
    });
  }
  return events;
}
