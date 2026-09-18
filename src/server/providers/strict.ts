// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The openai-strict wire: the plain wire's body with nothing outside
// the OpenAI chat spec, for a server that refuses any field it does
// not know (NVIDIA NIM, Groq). Thinking rides in reasoning_effort
// alone. Reasoning that goes back on an assistant message is named
// `reasoning`, the one name both take; Groq refuses
// `reasoning_content`. The stream is the plain wire's.

import { buildChatBody as buildOpenAiChatBody } from "./openai.ts";
import type { ChatRequest } from "./types.ts";

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req, {
    includeThinkingFlag: false,
    reasoningField: "reasoning",
  });
  delete body.prompt_cache_key;
  // OpenRouter's structured items stay with OpenRouter's rows; a
  // strict server refuses the field
  for (const message of body.messages as Record<string, unknown>[]) {
    delete message.reasoning_details;
  }
  // a model that never thinks refuses the field outright, so Off is
  // sent only when the agent chose it
  if (!req.thinking && req.thinkingOff) body.reasoning_effort = "none";
  return body;
}
