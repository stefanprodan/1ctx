// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ChatMessageIn, ChatRequest } from "./types.ts";

// whether a history message's reasoning goes back to the requested model:
// another model's chain is not its own to continue
export const sendsReasoning =
  (req: Pick<ChatRequest, "model">) =>
  (message: ChatMessageIn): boolean =>
    message.role === "assistant" &&
    !!message.reasoning &&
    message.model === req.model;

// the model's own past reasoning as reasoning_content on its assistant
// messages: templates that render it (Inkling, Qwen with
// preserve_thinking) lose quality without it and miss the prefix cache
export function withOwnReasoning(
  req: ChatRequest,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = body.messages as Record<string, unknown>[];
  const sends = sendsReasoning(req);
  req.messages.forEach((source, index) => {
    if (source.role === "assistant" && sends(source)) {
      messages[index]!.reasoning_content = source.reasoning;
    }
  });
  return body;
}
