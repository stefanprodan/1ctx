// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { Effort, Wire } from "../../shared/words.ts";

// the browser and the runner name one shape; the wire re-exports it
export type { ToolCall };

export type Fetcher = typeof fetch;

// Shared by the catalog readers without importing their dispatch.
export class CatalogError extends Error {}

export type ChatTool = {
  name: string;
  description: string;
  parameters: object;
};

// an OpenRouter reasoning_details item, or an azure reasoning or phase
// record; sent back as received
export type ReasoningDetail = {
  type: string;
  index?: number;
  [field: string]: unknown;
};

export type ChatMessageIn =
  | { role: "system"; content: string }
  // the author's name rides on a user message, so a model in a session
  // with more than one author knows who wrote what
  | { role: "user"; content: string; name?: string }
  | {
      role: "assistant";
      model?: string;
      content: string | null;
      reasoning?: string;
      reasoningDetails?: ReasoningDetail[];
      toolCalls?: ToolCall[];
    }
  | { role: "tool"; toolCallId: string; content: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessageIn[];
  thinking: boolean;
  // the agent chose Off; a strict server refuses the off field on a
  // model that never thinks
  thinkingOff?: boolean;
  // the least thinking for a short round; azure alone reads it
  least?: boolean;
  reasoningEffort?: Effort | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  tools?: ChatTool[];
  // the session id, so a provider that routes or caches by conversation
  // keeps one session's turns together; omitted when not set
  cacheKey?: string | null;
  // the OpenRouter endpoint tag tried first, others after it; another
  // wire has no such choice and never gets one
  upstream?: string | null;
  // OpenRouter alone: leave out the hosts serving the model at 4 bits
  skip4Bit?: boolean;
};

// the tokens and cost of one round, as the provider reported them: null
// where it did not say
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  // the prompt tokens written to the cache, which some models bill
  // apart; Azure and OpenRouter report them
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  // USD
  cost: number | null;
};

export type ChatEvent =
  | { kind: "reasoning"; text: string }
  // a streamed piece of reasoning_details; pieces with one index are one
  // item (openrouter.ts mergeReasoningDetail)
  | { kind: "reasoningDetail"; item: ReasoningDetail }
  | { kind: "content"; text: string }
  | {
      kind: "toolCallDelta";
      // assigned by the tracker, stable through the stored call array
      callIndex?: number;
      index?: number;
      id?: string;
      name?: string;
      arguments?: string;
      signature?: string;
    }
  // a call's whole arguments, replacing what its deltas built; consumed
  // by the stream, never yielded
  | { kind: "toolCallDone"; index: number; arguments: string }
  | { kind: "toolCalls"; calls: ToolCall[] }
  // a frame with nothing to show, or a change of thinking: while the
  // wire says the model is thinking, it may send nothing for minutes,
  // so the round lifts its idle check until thinking ends
  | { kind: "alive"; thinking: boolean }
  // the provider refused the stored reasoning sent back and the request
  // went again without it, so the caller forgets that reasoning
  | { kind: "reasoningRefused" }
  // native: the upstream's own stop reason, when a router passes it on
  | { kind: "finish"; reason: string; details: string | null; native?: string }
  // who served the round, from a router's frames: the upstream and the
  // model that answered, as the router named them
  | { kind: "served"; upstream: string | null; model: string | null }
  | { kind: "usage"; usage: Usage }
  | {
      kind: "error";
      message: string;
      // no response came at all: the connection failed or, with
      // timedOut, the headers wait ran out
      unanswered?: boolean;
      timedOut?: boolean;
      // the HTTP status, or the code an error frame names
      status?: number;
      // the words are the provider's, from its body or an error frame,
      // so a log never carries them
      remote?: boolean;
      // the response's Retry-After in milliseconds, when it had one
      retryAfterMs?: number;
      // the error's own code and the field it names, when the provider
      // gave them, so a wire matches a refusal by them and never by words
      code?: string;
      param?: string;
    };

export interface Provider {
  readonly id: string;
  readonly wire: Wire;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}
