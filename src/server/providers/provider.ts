// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider row, ready to talk to: the wire picks the body and the
// error text, the base URL and the key file name pick where and as
// whom. The key is read at each request, so a file added or rotated
// later is seen, and it never rides in an event: whatever a provider
// echoes back, and whatever the fetch throws, is scrubbed before the
// runner sees it. A failure is always an error event, never a throw,
// so the runner has one channel to finish a round on; a stop by the
// caller's signal ends the stream with no event, since the caller knows.

import type { Wire } from "../../shared/words.ts";
import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import { azureChat, azureUrls, countedText, responsesTools } from "./azure.ts";
import { azureEvents } from "./azure-stream.ts";
import {
  buildChatBody as buildGeminiChatBody,
  geminiError,
  geminiEvents,
} from "./gemini.ts";
import {
  buildChatBody as buildOpenAiChatBody,
  chatEvents,
  wireTokens as chatToolTokens,
  streamChat,
  Unanswered,
  wireTools,
} from "./openai.ts";
import {
  buildChatBody as buildOpenCodeChatBody,
  openCodeHeaders,
  sendsReasoning,
} from "./opencode.ts";
import {
  buildChatBody as buildOpenRouterChatBody,
  openRouterError,
  openRouterEvents,
} from "./openrouter.ts";
import type { ProviderRow } from "./store.ts";
import { buildChatBody as buildStrictChatBody } from "./strict.ts";
import type {
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  ChatTool,
  Fetcher,
  Provider,
} from "./types.ts";

export type ProviderDeps = {
  fetcher: Fetcher;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  // the headers wait, shorter in a test
  headersTimeoutMs?: number;
  // azure: the provider and model pairs that refused no thinking, kept
  // by the area until a restart
  noneRefused?: Set<string>;
  log?: Log;
};

export const OPENROUTER_HEADERS = {
  "http-referer": "https://1ctx.dev",
  "x-title": "1ctx",
};

// the messages as a fit counts them: a message's plain reasoning only
// where the wire sends it back
export function sentMessages(
  wire: Wire | null,
  model: string,
  messages: ChatMessageIn[],
): ChatMessageIn[] {
  const sends = wire === "opencode" ? sendsReasoning({ model }) : () => false;
  return messages.map((message) => {
    if (message.role !== "assistant" || sends(message)) return message;
    const { reasoning: _, ...rest } = message;
    return rest;
  });
}

// a request as the wire counts it: the Chat Completions messages and
// tools, or the Responses input and tools on azure
export function requestText(wire: Wire | null, req: ChatRequest): string {
  if (wire === "azure") return countedText(req);
  return JSON.stringify({
    messages: sentMessages(wire, req.model, req.messages),
    tools: wireTools(req.tools ?? []),
  });
}

// the tokens a request costs on the wire
export function requestTokens(wire: Wire | null, req: ChatRequest): number {
  return tokens(requestText(wire, req));
}

// the tokens tool schemas cost on the wire; with none named, the Chat
// Completions shape every other page counts
export function wireTokens(
  tools: readonly ChatTool[],
  wire: Wire | null = null,
): number {
  if (wire !== "azure") return chatToolTokens(tools);
  return tools.length === 0 ? 0 : tokens(JSON.stringify(responsesTools(tools)));
}

export function providerFor(row: ProviderRow, deps: ProviderDeps): Provider {
  const openRouter = row.wire === "openrouter";
  const gemini = row.wire === "gemini";
  const openCode = row.wire === "opencode";
  const azure = row.wire === "azure";
  const path = gemini ? "/openai/chat/completions" : "/chat/completions";
  const url = azure
    ? azureUrls(row.baseUrl).chat
    : `${row.baseUrl.replace(/\/+$/, "")}${path}`;
  const noneRefused = deps.noneRefused ?? new Set<string>();
  return {
    id: row.id,
    wire: row.wire,
    async *chat(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncIterable<ChatEvent> {
      const key = row.keyName === null ? null : deps.secret(row.keyName);
      if (row.keyName !== null && key === null) {
        yield {
          kind: "error",
          message: `${row.name} has no key file ${row.keyName}.key`,
        };
        return;
      }
      const headers: Record<string, string> = {
        ...(openRouter ? OPENROUTER_HEADERS : {}),
        ...(openCode ? openCodeHeaders(req.cacheKey) : {}),
        ...(key === null
          ? {}
          : azure
            ? { "api-key": key }
            : { authorization: `Bearer ${key}` }),
      };
      const timeout =
        deps.headersTimeoutMs === undefined
          ? {}
          : { headersTimeoutMs: deps.headersTimeoutMs };
      const chatBody = () =>
        openRouter
          ? buildOpenRouterChatBody(req)
          : gemini
            ? buildGeminiChatBody(req)
            : row.wire === "openai-strict"
              ? buildStrictChatBody(req)
              : openCode
                ? buildOpenCodeChatBody(req)
                : buildOpenAiChatBody(req);
      const scrub = (message: string) =>
        key === null ? message : message.replaceAll(key, "[key]");
      const events = azure
        ? azureChat(req, {
            open: (body) => {
              const stream = azureEvents();
              return streamChat(deps.fetcher, url, body, signal, {
                mapEvents: stream.map,
                ended: stream.ended,
                thinking: stream.thinking,
                headers,
                ...timeout,
              });
            },
            noneRefused,
            providerId: row.id,
            providerName: row.name,
            ...(deps.log === undefined ? {} : { log: deps.log }),
          })
        : streamChat(deps.fetcher, url, chatBody(), signal, {
            mapEvents: openRouter
              ? openRouterEvents
              : gemini
                ? geminiEvents()
                : chatEvents,
            headers,
            ...timeout,
          });
      try {
        for await (const event of events) {
          if (event.kind !== "error") {
            yield event;
            continue;
          }
          yield {
            ...event,
            message: scrub(
              openRouter
                ? openRouterError(event.message)
                : gemini
                  ? geminiError(event.message)
                  : event.message,
            ),
          };
        }
      } catch (err) {
        if (signal.aborted) return;
        yield {
          kind: "error",
          message: scrub(
            `${row.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
          ...(err instanceof Unanswered
            ? { unanswered: true, ...(err.timedOut ? { timedOut: true } : {}) }
            : {}),
        };
      }
    },
  };
}
