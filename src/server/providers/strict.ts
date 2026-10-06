// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { baseChatBody } from "./openai.ts";
import type { ChatRequest } from "./types.ts";

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  return baseChatBody(req, {
    usageOption: true,
    effort: true,
    offAsNone: true,
  });
}
