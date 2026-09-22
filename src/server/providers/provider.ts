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

import {
  buildChatBody as buildGeminiChatBody,
  geminiError,
  geminiEvents,
} from "./gemini.ts";
import {
  buildChatBody as buildOpenAiChatBody,
  chatEvents,
  streamChat,
  Unanswered,
} from "./openai.ts";
import {
  buildChatBody as buildOpenRouterChatBody,
  openRouterError,
  openRouterEvents,
} from "./openrouter.ts";
import type { ProviderRow } from "./store.ts";
import { buildChatBody as buildStrictChatBody } from "./strict.ts";
import type { ChatEvent, ChatRequest, Fetcher, Provider } from "./types.ts";

export type ProviderDeps = {
  fetcher: Fetcher;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
};

const OPENROUTER_HEADERS = {
  "http-referer": "https://1ctx.dev",
  "x-title": "1ctx",
};

export function providerFor(row: ProviderRow, deps: ProviderDeps): Provider {
  const openRouter = row.wire === "openrouter";
  const gemini = row.wire === "gemini";
  const path = gemini ? "/openai/chat/completions" : "/chat/completions";
  const url = `${row.baseUrl.replace(/\/+$/, "")}${path}`;
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
        ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      };
      const body = openRouter
        ? buildOpenRouterChatBody(req)
        : gemini
          ? buildGeminiChatBody(req)
          : row.wire === "openai-strict"
            ? buildStrictChatBody(req)
            : buildOpenAiChatBody(req);
      const scrub = (message: string) =>
        key === null ? message : message.replaceAll(key, "[key]");
      const events = streamChat(deps.fetcher, url, body, signal, {
        mapEvents: openRouter
          ? openRouterEvents
          : gemini
            ? geminiEvents()
            : chatEvents,
        headers,
      });
      try {
        for await (const event of events) {
          if (event.kind !== "error") {
            yield event;
            continue;
          }
          yield {
            kind: "error",
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
          ...(err instanceof Unanswered ? { unanswered: true } : {}),
        };
      }
    },
  };
}
