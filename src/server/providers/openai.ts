// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenAI chat completions wire, as every provider speaks it: the
// request body from a ChatRequest, the SSE frames to ChatEvents, the
// tool call fragments joined into calls, and the stream with its
// timeouts and caps. What reaches the provider goes through the fetcher
// the caller passes, so a test hands it recorded frames and the suite
// never reaches a network.

import { tokens } from "../lib/tokens.ts";
import type {
  ChatEvent,
  ChatRequest,
  ChatTool,
  Fetcher,
  ReasoningDetail,
  ToolCall,
} from "./types.ts";

export const CHAT_HEADERS_TIMEOUT_MS = 30_000;
const CHAT_SILENCE_TIMEOUT_MS = 5 * 60_000;
export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const CHAT_ERROR_BODY_MAX_BYTES = 4 * 1024;
const CHAT_ERROR_BODY_TIMEOUT_MS = 10_000;
const OVERSIZED_SSE_FRAME = "the provider sent an oversized stream frame";

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

// the name field on a user message, as OpenAI-compatible servers accept
// it: letters, digits, underscore and dash, at most 64; a username's
// dots become underscores rather than refusing the whole request
export function wireName(name: string): string | null {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe === "" ? null : safe;
}

export type ChatBodyOptions = {
  // the field earlier reasoning goes back in on an assistant message:
  // reasoning_content (mlx-serve, llama-server) or reasoning (OpenRouter)
  reasoningField?: "reasoning_content" | "reasoning";
  includeThinkingFlag?: boolean;
};

export function buildChatBody(
  req: ChatRequest,
  options: ChatBodyOptions = {},
): Record<string, unknown> {
  const reasoningField = options.reasoningField ?? "reasoning_content";
  const messages = req.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === "user") {
      const name = message.name ? wireName(message.name) : null;
      return {
        role: "user",
        content: message.content,
        ...(name === null ? {} : { name }),
      };
    }
    if (message.role === "system") {
      return { role: "system", content: message.content };
    }
    const toolCalls = message.toolCalls ?? [];
    return {
      role: "assistant",
      content:
        toolCalls.length > 0 && message.content === "" ? null : message.content,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      // OpenRouter takes the structured items in place of the text: the
      // signature or the encrypted blob is what lets a Claude or an OpenAI
      // model continue its chain across a tool round
      ...(reasoningField === "reasoning" &&
      message.reasoningDetails &&
      message.reasoningDetails.length > 0
        ? { reasoning_details: message.reasoningDetails }
        : message.reasoning
          ? { [reasoningField]: message.reasoning }
          : {}),
    };
  });
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // mlx-serve and llama-server read the flag on every request, off
  // included; OpenRouter takes the reasoning object instead
  if (options.includeThinkingFlag ?? true) {
    body.enable_thinking = req.thinking;
  }
  if (req.thinking && req.reasoningEffort) {
    body.reasoning_effort = req.reasoningEffort;
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = wireTools(req.tools);
    // the answer round keeps the schemas but forbids a call
    if (req.toolChoice === "none") body.tool_choice = "none";
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.topP != null) body.top_p = req.topP;
  if (req.cacheKey) body.prompt_cache_key = req.cacheKey;
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  return body;
}

// the tools as the chat body carries them; a page counting what a
// request costs serializes them the same way
export function wireTools(
  tools: readonly ChatTool[],
): { type: "function"; function: ChatTool }[] {
  return tools.map((tool) => ({ type: "function", function: tool }));
}

// the tokens those schemas cost, the one count every page shows
export function wireTokens(tools: readonly ChatTool[]): number {
  return tools.length === 0 ? 0 : tokens(JSON.stringify(wireTools(tools)));
}

// Frames are returned as their joined data payload. Comments count as bytes
// for liveness in the reader but carry no event for the runner.
export function parseSse(
  buffer: string,
  chunk: string,
): { frames: string[]; rest: string } {
  let rest = buffer + chunk;
  const frames: string[] = [];
  while (true) {
    const split = /\r?\n\r?\n/.exec(rest);
    if (!split || split.index === undefined) break;
    const raw = rest.slice(0, split.index);
    if (new TextEncoder().encode(raw).byteLength > MAX_SSE_FRAME_BYTES) {
      throw new Error(OVERSIZED_SSE_FRAME);
    }
    rest = rest.slice(split.index + split[0].length);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(":"))
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) frames.push(data.join("\n"));
  }
  if (new TextEncoder().encode(rest).byteLength > MAX_SSE_FRAME_BYTES) {
    throw new Error(OVERSIZED_SSE_FRAME);
  }
  return { frames, rest };
}

export function chatEvents(json: string): ChatEvent[] {
  if (json.trim() === "[DONE]") return [];
  let body: any;
  try {
    body = JSON.parse(json);
  } catch {
    return [{ kind: "error", message: "invalid JSON in the stream" }];
  }
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
    events.push({
      kind: "finish",
      reason: choice.finish_reason,
      details:
        typeof choice.finish_details?.type === "string"
          ? choice.finish_details.type
          : null,
    });
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

type TrackedCall = {
  index: number | null;
  id: string;
  name: string;
  arguments: string;
  signature?: string;
  order: number;
};

export class ToolCallTracker {
  private readonly calls: TrackedCall[] = [];
  private readonly byIndex = new Map<number, TrackedCall>();
  private readonly byId = new Map<string, TrackedCall>();
  private latest: TrackedCall | null = null;
  private nextOrder = 0;

  push(delta: Extract<ChatEvent, { kind: "toolCallDelta" }>): void {
    let call: TrackedCall | undefined;
    if (delta.index !== undefined) call = this.byIndex.get(delta.index);
    if (!call && delta.index === undefined && delta.id !== undefined) {
      call = this.byId.get(delta.id);
    }
    if (!call && this.latest) {
      const latestCanAcceptIndex =
        delta.index === undefined ||
        this.latest.index === null ||
        this.latest.index === delta.index;
      const latestCanAcceptId =
        delta.id === undefined ||
        this.latest.id === "" ||
        this.latest.id === delta.id;
      if (latestCanAcceptIndex && latestCanAcceptId) call = this.latest;
    }
    if (!call) {
      call = {
        index: delta.index ?? null,
        id: delta.id ?? "",
        name: "",
        arguments: "",
        order: this.nextOrder++,
      };
      this.calls.push(call);
    }
    if (delta.index !== undefined) {
      call.index = delta.index;
      this.byIndex.set(delta.index, call);
    }
    if (delta.id !== undefined) {
      call.id = delta.id;
      this.byId.set(delta.id, call);
    }
    if (delta.name !== undefined) call.name = delta.name;
    if (delta.arguments !== undefined) call.arguments += delta.arguments;
    if (delta.signature !== undefined) call.signature = delta.signature;
    this.latest = call;
  }

  flush(): ToolCall[] {
    const sorted = [...this.calls].sort((left, right) => {
      if (left.index !== null && right.index !== null) {
        return left.index - right.index;
      }
      if (left.index !== null) return -1;
      if (right.index !== null) return 1;
      return left.order - right.order;
    });
    return sorted.map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.name,
      arguments: call.arguments,
      ...(call.signature === undefined ? {} : { signature: call.signature }),
    }));
  }
}

async function readErrorBody(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  type ReadResult =
    | { kind: "read"; done: boolean; value?: Uint8Array }
    | { kind: "timeout" };
  const timeout = new Promise<ReadResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      CHAT_ERROR_BODY_TIMEOUT_MS,
    );
  });
  try {
    while (size < CHAT_ERROR_BODY_MAX_BYTES) {
      const read: Promise<ReadResult> = reader.read().then((result) => ({
        kind: "read",
        done: result.done,
        value: result.value,
      }));
      const result = await Promise.race([read, timeout]);
      if (result.kind === "timeout") {
        controller.abort(new Error("the error body timed out"));
        return "";
      }
      if (result.done || !result.value) break;
      const remaining = CHAT_ERROR_BODY_MAX_BYTES - size;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type StreamOptions = {
  mapEvents?: (json: string) => ChatEvent[];
  headers?: Record<string, string>;
};

export async function* streamChat(
  fetcher: Fetcher,
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  options: StreamOptions = {},
): AsyncIterable<ChatEvent> {
  const mapEvents = options.mapEvents ?? chatEvents;
  const headers = options.headers ?? {};
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const headersTimer = setTimeout(
    () => controller.abort(new Error("the response headers timed out")),
    CHAT_HEADERS_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: combined,
    });
  } finally {
    clearTimeout(headersTimer);
  }
  if (!response.ok) {
    const text = await readErrorBody(response, controller);
    yield {
      kind: "error",
      message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
    };
    return;
  }
  if (!response.body) {
    yield { kind: "error", message: "the response has no stream" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const tracker = new ToolCallTracker();
  let rest = "";
  let done = false;
  let sawFinish = false;
  try {
    while (!done) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const silence = new Promise<{ silent: true }>((resolve) => {
        timer = setTimeout(
          () => resolve({ silent: true }),
          CHAT_SILENCE_TIMEOUT_MS,
        );
      });
      const result = await Promise.race([read, silence]);
      if (timer) clearTimeout(timer);
      if ("silent" in result) {
        controller.abort(new Error("the provider was silent for 5 min"));
        yield { kind: "error", message: "the provider was silent for 5 min" };
        return;
      }
      if ("error" in result) throw result.error;
      if (result.value.done) break;
      let parsed: ReturnType<typeof parseSse>;
      try {
        parsed = parseSse(
          rest,
          decoder.decode(result.value.value, { stream: true }),
        );
      } catch (err) {
        if (!(err instanceof Error) || err.message !== OVERSIZED_SSE_FRAME) {
          throw err;
        }
        controller.abort(err);
        yield { kind: "error", message: OVERSIZED_SSE_FRAME };
        return;
      }
      rest = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.trim() === "[DONE]") {
          done = true;
          break;
        }
        for (const event of mapEvents(frame)) {
          if (event.kind === "toolCallDelta") tracker.push(event);
          if (event.kind === "finish") sawFinish = true;
          yield event;
        }
      }
    }
    const calls = tracker.flush();
    if (calls.length > 0) yield { kind: "toolCalls", calls };
    if (!sawFinish) yield { kind: "error", message: "stream ended early" };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
