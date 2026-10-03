// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The opencode wire, for OpenCode Go: the body OpenCode itself sends.
// No enable_thinking and no prompt_cache_key, since the session headers
// (provider.ts) keep a chat on the upstream holding its cache. Past
// reasoning goes back as reasoning_content on every assistant message
// the requested model wrote, every turn, as OpenCode does; another
// model's is dropped, since it would read as this model's own, and an
// empty one is never sent. The stream is the plain wire's.

import { buildChatBody as buildOpenAiChatBody } from "./openai.ts";
import type { ChatMessageIn, ChatRequest } from "./types.ts";

// the session headers OpenCode sends, each the chat's cache key: Go's
// docs require x-opencode-session, and its newer service reads the rest
export function openCodeHeaders(
  cacheKey: string | null | undefined,
): Record<string, string> {
  if (!cacheKey) return {};
  return {
    "x-opencode-session": cacheKey,
    "x-opencode-session-id": cacheKey,
    "x-session-affinity": cacheKey,
    "X-Session-Id": cacheKey,
  };
}

// whether a history message's reasoning goes back to the requested model
export const sendsReasoning =
  (req: Pick<ChatRequest, "model">) =>
  (message: ChatMessageIn): boolean =>
    message.role === "assistant" &&
    !!message.reasoning &&
    message.model === req.model;

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req, { includeThinkingFlag: false });
  delete body.prompt_cache_key;
  const messages = body.messages as Record<string, unknown>[];
  const sends = sendsReasoning(req);
  req.messages.forEach((source, index) => {
    if (source.role === "assistant" && sends(source)) {
      messages[index]!.reasoning_content = source.reasoning;
    }
  });
  // every family checked stops thinking on none but a thinking-only
  // model, which refuses it in its own words; a default that resolved
  // to off sends nothing
  if (!req.thinking && req.thinkingOff) body.reasoning_effort = "none";
  return body;
}
