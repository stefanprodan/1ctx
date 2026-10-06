// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { MINUTE_MS } from "../lib/clock.ts";
import { messageOf } from "../lib/errors.ts";
import { tokens } from "../lib/tokens.ts";
import { chatEvents } from "./frames.ts";
import type {
  ChatEvent,
  ChatRequest,
  ChatTool,
  Fetcher,
  ToolCall,
} from "./types.ts";

// Gemini holds the headers while it thinks on a long prompt
const CHAT_HEADERS_TIMEOUT_MS = 120_000;
const CHAT_SILENCE_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const CHAT_ERROR_BODY_MAX_BYTES = 4 * 1024;
const CHAT_ERROR_BODY_TIMEOUT_MS = 10_000;
const OVERSIZED_SSE_FRAME = "the provider sent an oversized stream frame";

// the name field on a user message, as OpenAI-compatible servers accept
// it: letters, digits, underscore and dash, at most 64; a username's
// dots become underscores rather than refusing the whole request
export function wireName(name: string): string | null {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe === "" ? null : safe;
}

// the fields a wire takes beyond the spec's, each off unless asked for
export type ChatBodyOptions = {
  // OpenRouter's structured reasoning items go back on its assistant
  // messages; a message's plain reasoning goes back only where a wire's
  // own builder adds it (opencode.ts)
  reasoningDetails?: boolean;
  // enable_thinking, sent on every request, off included
  thinkingFlag?: boolean;
  usageOption?: boolean;
  effort?: boolean;
  cacheKey?: boolean;
  // reasoning_effort none on the agent's own Off: a model that never
  // thinks refuses the field, so a default that resolved to off sends
  // nothing
  offAsNone?: boolean;
};

// the openai-compatible body (mlx-serve, llama-server)
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  return baseChatBody(req, {
    thinkingFlag: true,
    usageOption: true,
    effort: true,
    cacheKey: true,
  });
}

export function baseChatBody(
  req: ChatRequest,
  options: ChatBodyOptions,
): Record<string, unknown> {
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
      ...(options.reasoningDetails &&
      message.reasoningDetails &&
      message.reasoningDetails.length > 0
        ? { reasoning_details: message.reasoningDetails }
        : {}),
    };
  });
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
  };
  if (options.usageOption) body.stream_options = { include_usage: true };
  if (options.thinkingFlag) body.enable_thinking = req.thinking;
  if (options.effort && req.thinking && req.reasoningEffort) {
    body.reasoning_effort = req.reasoningEffort;
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = wireTools(req.tools);
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.topP != null) body.top_p = req.topP;
  if (options.cacheKey && req.cacheKey) body.prompt_cache_key = req.cacheKey;
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  if (options.offAsNone && !req.thinking && req.thinkingOff) {
    body.reasoning_effort = "none";
  }
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
    if (Buffer.byteLength(raw) > MAX_SSE_FRAME_BYTES) {
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
  if (Buffer.byteLength(rest) > MAX_SSE_FRAME_BYTES) {
    throw new Error(OVERSIZED_SSE_FRAME);
  }
  return { frames, rest };
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
  push(delta: Extract<ChatEvent, { kind: "toolCallDelta" }>): {
    callIndex: number;
    name: string;
  } {
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
        order: this.calls.length,
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
    return { callIndex: call.order, name: call.name };
  }

  // the whole arguments a wire gives when a call ends, which win over
  // the deltas
  replace(index: number, args: string): void {
    const call = this.byIndex.get(index);
    if (call) call.arguments = args;
    else this.push({ kind: "toolCallDelta", index, arguments: args });
  }

  flush(): ToolCall[] {
    // A late sparse index must not move a call already streaming to a reader.
    return this.calls.map((call, index) => ({
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
    return new TextDecoder().decode(Buffer.concat(chunks, size));
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// no response at all, so asking again is safe; timedOut when the
// headers wait ran out, which the round asks again only once
export class Unanswered extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

// an HTTP date as RFC 9110 requires a sender to write it
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// Retry-After as whole seconds or an IMF-fixdate, in milliseconds from
// now; a date already past is no wait, anything else is not a Retry-After
export function retryAfterMs(header: string | null, now: number) {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export type StreamOptions = {
  mapEvents?: (json: string) => ChatEvent[];
  // a refused request's body in the wire's own words; null, or no hook,
  // keeps HTTP <status>: <body>
  refusal?: (
    status: number,
    body: string,
  ) => { message: string; code?: string; param?: string } | null;
  headers?: Record<string, string>;
  // shorter in a test
  headersTimeoutMs?: number;
  // shorter in a test
  silenceMs?: number;
  // asked after each frame: the wire's terminal event came, so the read
  // ends there, for a wire that sends no [DONE]
  ended?: () => boolean;
  // asked before each read: the model is thinking, which a wire may do
  // in silence for longer than the silence limit, so that read waits
  // with none and the send's deadline ends it
  thinking?: () => boolean;
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
  let timedOut = false;
  const headersTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("the response headers timed out"));
  }, options.headersTimeoutMs ?? CHAT_HEADERS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Unanswered(messageOf(err), timedOut);
  } finally {
    clearTimeout(headersTimer);
  }
  if (!response.ok) {
    const wait = retryAfterMs(response.headers.get("retry-after"), Date.now());
    const text = await readErrorBody(response, controller);
    const own = text ? options.refusal?.(response.status, text) : null;
    yield {
      kind: "error",
      message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
      status: response.status,
      remote: true,
      ...own,
      ...(wait === null ? {} : { retryAfterMs: wait }),
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
      const silence = options.thinking?.()
        ? null
        : new Promise<{ silent: true }>((resolve) => {
            timer = setTimeout(
              () => resolve({ silent: true }),
              options.silenceMs ?? CHAT_SILENCE_TIMEOUT_MS,
            );
          });
      const result = await (silence ? Promise.race([read, silence]) : read);
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
          if (event.kind === "toolCallDelta") {
            yield { ...event, ...tracker.push(event) };
            continue;
          }
          if (event.kind === "toolCallDone") {
            tracker.replace(event.index, event.arguments);
            continue;
          }
          if (event.kind === "finish") sawFinish = true;
          yield event;
        }
        if (options.ended?.()) {
          done = true;
          break;
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
