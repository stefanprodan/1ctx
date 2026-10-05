// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { baseChatBody } from "./openai.ts";
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
  const body = baseChatBody(req, {
    usageOption: true,
    effort: true,
    offAsNone: true,
  });
  const messages = body.messages as Record<string, unknown>[];
  const sends = sendsReasoning(req);
  req.messages.forEach((source, index) => {
    if (source.role === "assistant" && sends(source)) {
      messages[index]!.reasoning_content = source.reasoning;
    }
  });
  return body;
}
