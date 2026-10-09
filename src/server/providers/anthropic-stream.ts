// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { num, parseFrame } from "./frames.ts";
import type { ChatEvent } from "./types.ts";

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// an error frame names no status, so its type gives one the round can
// retry on
const ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
};

// an error body or frame in the wire's words, its type as the code
export function errorEvent(
  error: unknown,
  status?: number,
): Extract<ChatEvent, { kind: "error" }> {
  const fields = (error ?? {}) as Record<string, unknown>;
  const message = text(fields.message) ?? "the provider failed";
  const code = text(fields.type);
  const named = status ?? (code === undefined ? undefined : ERROR_STATUS[code]);
  return {
    kind: "error",
    message: code ? `${code}: ${message}` : message,
    remote: true,
    ...(named === undefined ? {} : { status: named }),
    ...(code ? { code } : {}),
  };
}

const finishOf = (
  reason: string | undefined,
): Extract<ChatEvent, { kind: "finish" }> => {
  switch (reason) {
    case undefined:
    case "end_turn":
    case "stop_sequence":
      return { kind: "finish", reason: "stop", details: null };
    case "tool_use":
      return { kind: "finish", reason: "tool_calls", details: null };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { kind: "finish", reason: "length", details: null };
    case "refusal":
      return { kind: "finish", reason: "content_filter", details: "refusal" };
    default:
      // pause_turn comes only from server tools, which 1ctx never sends
      return { kind: "finish", reason: "stop", details: reason };
  }
};

// input_tokens is the uncached part alone, so the prompt adds the cache
function usageEvent(usage: any): ChatEvent {
  const read = usage.cache_read_input_tokens;
  const written = usage.cache_creation_input_tokens;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  return {
    kind: "usage",
    usage: {
      promptTokens: num(usage.input_tokens) + num(read) + num(written),
      completionTokens: num(usage.output_tokens),
      cachedTokens: typeof read === "number" ? read : null,
      cacheWriteTokens: typeof written === "number" ? written : null,
      reasoningTokens: typeof thinking === "number" ? thinking : null,
      cost: null,
    },
  };
}

const INPUT_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

type Block = {
  type: string;
  thinking: string;
  signature: string;
  data?: string;
  // a tool_use block's arguments as streamed, and its opening input
  args: string;
  input?: unknown;
};

type AnthropicStream = {
  map(json: string): ChatEvent[];
  // message_stop or an error frame came
  ended(): boolean;
  // a thinking block is open
  thinking(): boolean;
};

export function anthropicEvents(): AnthropicStream {
  let ended = false;
  const blocks = new Map<number, Block>();
  const open = new Set<number>();
  let wasThinking = false;
  // thinking blocks shown so far, so the next opens with a blank line
  let shown = false;
  let blockShown = false;
  let contentShown = false;
  // message_start's input counts: a server may report them only there
  let started: Record<string, number> = {};

  const start = (index: number, block: any): ChatEvent[] => {
    const type = text(block?.type) ?? "";
    const entry: Block = { type, thinking: "", signature: "", args: "" };
    blocks.set(index, entry);
    if (type === "thinking") {
      open.add(index);
      blockShown = false;
      return thinkingText(entry, text(block.thinking) ?? "");
    }
    if (type === "redacted_thinking") entry.data = text(block.data);
    if (type === "text") return contentText(text(block.text) ?? "");
    if (type === "tool_use") {
      entry.input = block.input;
      return [
        {
          kind: "toolCallDelta",
          index,
          ...(text(block.id) ? { id: block.id } : {}),
          ...(text(block.name) ? { name: block.name } : {}),
        },
      ];
    }
    return [];
  };

  const thinkingText = (entry: Block, piece: string): ChatEvent[] => {
    if (piece === "") return [];
    entry.thinking += piece;
    const lead = shown && !blockShown ? "\n\n" : "";
    shown = true;
    blockShown = true;
    return [{ kind: "reasoning", text: `${lead}${piece}` }];
  };

  const contentText = (piece: string): ChatEvent[] => {
    if (piece === "") return [];
    contentShown = true;
    return [{ kind: "content", text: piece }];
  };

  const delta = (index: number, delta: any): ChatEvent[] => {
    const entry = blocks.get(index);
    switch (delta?.type) {
      case "text_delta":
        return contentText(text(delta.text) ?? "");
      case "thinking_delta":
        return entry ? thinkingText(entry, text(delta.thinking) ?? "") : [];
      case "signature_delta":
        if (entry) entry.signature += text(delta.signature) ?? "";
        return [];
      case "input_json_delta": {
        const piece = text(delta.partial_json);
        if (!piece) return [];
        if (entry) entry.args += piece;
        return [{ kind: "toolCallDelta", index, arguments: piece }];
      }
      default:
        // citations are dropped: 1ctx shows its own sources
        return [];
    }
  };

  // a block is kept only once closed, so a stopped reply holds whole
  // blocks alone
  const stop = (index: number): ChatEvent[] => {
    open.delete(index);
    const entry = blocks.get(index);
    if (entry?.type === "thinking") {
      return [
        {
          kind: "reasoningDetail",
          item: {
            type: "thinking",
            index,
            thinking: entry.thinking,
            signature: entry.signature,
          },
        },
      ];
    }
    if (entry?.type === "redacted_thinking" && entry.data !== undefined) {
      return [
        {
          kind: "reasoningDetail",
          item: { type: "redacted_thinking", index, data: entry.data },
        },
      ];
    }
    if (entry?.type === "tool_use" && entry.args === "") {
      const input =
        entry.input !== null && typeof entry.input === "object"
          ? entry.input
          : {};
      return [
        { kind: "toolCallDone", index, arguments: JSON.stringify(input) },
      ];
    }
    return [];
  };

  // the refusal's own explanation is the reply's words
  const finish = (body: any): ChatEvent[] => {
    const events: ChatEvent[] = [];
    const reason = text(body.delta?.stop_reason);
    const explanation = text(body.delta?.stop_details?.explanation);
    if (reason === "refusal" && explanation) {
      events.push(
        ...contentText(`${contentShown ? "\n\n" : ""}${explanation}`),
      );
    }
    if (body.usage && typeof body.usage === "object") {
      // a null field is no answer and keeps what message_start said
      const usage: Record<string, unknown> = { ...started };
      for (const [field, value] of Object.entries(body.usage)) {
        if (value !== null && value !== undefined) usage[field] = value;
      }
      events.push(usageEvent(usage));
    }
    if (reason !== undefined) events.push(finishOf(reason));
    return events;
  };

  const mapFrame = (body: any): ChatEvent[] => {
    const index = typeof body?.index === "number" ? body.index : 0;
    switch (body?.type) {
      case "content_block_start":
        return start(index, body.content_block);
      case "content_block_delta":
        return delta(index, body.delta);
      case "content_block_stop":
        return stop(index);
      // usage comes once, at message_delta: one at message_start would
      // count as output and end the round's retries before anything was
      // shown, so its input counts only fill what message_delta leaves out
      case "message_start": {
        const usage = body.message?.usage;
        if (usage && typeof usage === "object") {
          started = {};
          for (const field of INPUT_FIELDS) {
            if (typeof usage[field] === "number") started[field] = usage[field];
          }
        }
        return [];
      }
      case "message_delta":
        return finish(body);
      case "message_stop":
        ended = true;
        open.clear();
        return [];
      case "error":
        ended = true;
        open.clear();
        return [errorEvent(body.error)];
      default:
        return [];
    }
  };

  // a frame with nothing to show, or a change of thinking, is alive
  const map = (json: string): ChatEvent[] => {
    const frame = parseFrame(json);
    if (!frame.ok) return frame.events;
    const events = mapFrame(frame.value);
    const now = open.size > 0;
    if (events.length > 0 && now === wasThinking) return events;
    wasThinking = now;
    return [...events, { kind: "alive", thinking: now }];
  };

  return { map, ended: () => ended, thinking: () => open.size > 0 };
}
