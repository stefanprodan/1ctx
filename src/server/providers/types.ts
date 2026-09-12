// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat wire as the runner sees it: one request shape in, one event
// stream out, whatever the provider behind it. A wire adapter translates
// its server's names into these and nothing else crosses.

import type { Wire } from "../../shared/words.ts";

export type ChatTool = {
  name: string;
  description: string;
  parameters: object;
};

export type ToolCall = { id: string; name: string; arguments: string };

// One item of OpenRouter's reasoning_details: reasoning.text (with the
// signature an Anthropic upstream needs back), reasoning.summary or
// reasoning.encrypted (OpenAI's opaque blob). Kept whole and sent back as
// received, since the upstream verifies the sequence.
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
  reasoningEffort?: string | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  tools?: ChatTool[];
  // the session id, so a provider that routes or caches by conversation
  // keeps one session's turns together; omitted when not set
  cacheKey?: string | null;
};

// the tokens and cost of one round, as the provider reported them: null
// where it did not say
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
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
      index?: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { kind: "toolCalls"; calls: ToolCall[] }
  | { kind: "finish"; reason: string; details: string | null }
  | { kind: "usage"; usage: Usage }
  | { kind: "error"; message: string };

// one provider row, ready to talk to
export interface Provider {
  readonly id: string;
  readonly wire: Wire;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}
