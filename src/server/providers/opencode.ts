// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type ImageData, NO_IMAGE_DATA } from "./images.ts";
import { baseChatBody } from "./openai.ts";
import { withOwnReasoning } from "./reasoning.ts";
import type { ChatRequest } from "./types.ts";

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

export function buildChatBody(
  req: ChatRequest,
  images: ImageData = NO_IMAGE_DATA,
): Record<string, unknown> {
  return withOwnReasoning(
    req,
    baseChatBody(req, {
      usageOption: true,
      effort: true,
      offAsNone: true,
      images,
    }),
  );
}
