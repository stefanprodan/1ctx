// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type ImageData, NO_IMAGE_DATA } from "./images.ts";
import { baseChatBody } from "./openai.ts";
import type { ChatRequest } from "./types.ts";

export function buildChatBody(
  req: ChatRequest,
  images: ImageData = NO_IMAGE_DATA,
): Record<string, unknown> {
  return baseChatBody(req, {
    usageOption: true,
    effort: true,
    offAsNone: true,
    images,
  });
}
