// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Wire } from "../../shared/words.ts";
import { chatEvents } from "./frames.ts";
import {
  buildChatBody as buildGeminiChatBody,
  geminiError,
  geminiEvents,
} from "./gemini.ts";
import {
  buildChatBody as buildOpenAiChatBody,
  type StreamOptions,
} from "./openai.ts";
import {
  buildChatBody as buildOpenCodeChatBody,
  openCodeHeaders,
} from "./opencode.ts";
import {
  buildChatBody as buildOpenRouterChatBody,
  OPENROUTER_HEADERS,
  openRouterError,
  openRouterEvents,
} from "./openrouter.ts";
import { buildChatBody as buildStrictChatBody } from "./strict.ts";
import type { ChatEvent, ChatRequest } from "./types.ts";

// a path under the base URL, which parseBaseUrl already trimmed
export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Gemini's catalog alone reads its own header
export function authHeaders(
  wire: Wire,
  key: string | null,
  purpose: "chat" | "catalog" = "chat",
): Record<string, string> {
  if (key === null) return {};
  if (wire === "azure") return { "api-key": key };
  if (wire === "gemini" && purpose === "catalog") {
    return { "x-goog-api-key": key };
  }
  return { authorization: `Bearer ${key}` };
}

type ChatWire = {
  path: string;
  headers(req: ChatRequest): Record<string, string>;
  body(req: ChatRequest): Record<string, unknown>;
  events(): (json: string) => ChatEvent[];
  refusal?: StreamOptions["refusal"];
};

const none = () => ({});

// every wire but azure, whose Responses API is its own (azure.ts)
export const CHAT_WIRES: Record<Exclude<Wire, "azure">, ChatWire> = {
  openrouter: {
    path: "/chat/completions",
    headers: () => OPENROUTER_HEADERS,
    body: buildOpenRouterChatBody,
    events: () => openRouterEvents,
    refusal: openRouterError,
  },
  "openai-compatible": {
    path: "/chat/completions",
    headers: none,
    body: buildOpenAiChatBody,
    events: () => chatEvents,
  },
  "openai-strict": {
    path: "/chat/completions",
    headers: none,
    body: buildStrictChatBody,
    events: () => chatEvents,
  },
  gemini: {
    path: "/openai/chat/completions",
    headers: none,
    body: buildGeminiChatBody,
    events: geminiEvents,
    refusal: geminiError,
  },
  opencode: {
    path: "/chat/completions",
    headers: (req) => openCodeHeaders(req.cacheKey),
    body: buildOpenCodeChatBody,
    events: () => chatEvents,
  },
};
