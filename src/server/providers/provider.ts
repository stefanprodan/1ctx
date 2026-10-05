// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Wire } from "../../shared/words.ts";
import type { Log } from "../lib/log.ts";
import { tokens } from "../lib/tokens.ts";
import {
  azureChat,
  azureError,
  azureUrls,
  countedText,
  responsesTools,
} from "./azure.ts";
import { azureEvents } from "./azure-stream.ts";
import {
  wireTokens as chatToolTokens,
  type StreamOptions,
  streamChat,
  Unanswered,
  wireTools,
} from "./openai.ts";
import { sendsReasoning } from "./opencode.ts";
import type { ProviderRow } from "./store.ts";
import type {
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  ChatTool,
  Fetcher,
  Provider,
} from "./types.ts";
import { authHeaders, CHAT_WIRES, endpoint } from "./wires.ts";

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

// the key file's value, null for a provider that needs none or whose
// file is missing (noKeyFile)
export function keyOf(
  row: Pick<ProviderRow, "keyName">,
  secret: (name: string) => string | null,
): string | null {
  return row.keyName === null ? null : secret(row.keyName);
}

export const noKeyFile = (row: Pick<ProviderRow, "name" | "keyName">) =>
  `${row.name} has no key file ${row.keyName}.key`;

export function scrubKey(text: string, key: string | null): string {
  return key === null ? text : text.replaceAll(key, "[key]");
}

// the messages as a fit counts them: a message's plain reasoning only
// where the wire sends it back
function sentMessages(
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
  const noneRefused = deps.noneRefused ?? new Set<string>();
  return {
    id: row.id,
    wire: row.wire,
    async *chat(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncIterable<ChatEvent> {
      const key = keyOf(row, deps.secret);
      if (row.keyName !== null && key === null) {
        yield { kind: "error", message: noKeyFile(row) };
        return;
      }
      const options: StreamOptions =
        deps.headersTimeoutMs === undefined
          ? {}
          : { headersTimeoutMs: deps.headersTimeoutMs };
      const open = (): AsyncIterable<ChatEvent> => {
        if (row.wire === "azure") {
          const url = azureUrls(row.baseUrl).chat;
          return azureChat(req, {
            open: (body) => {
              const stream = azureEvents();
              return streamChat(deps.fetcher, url, body, signal, {
                ...options,
                mapEvents: stream.map,
                ended: stream.ended,
                thinking: stream.thinking,
                refusal: azureError,
                headers: authHeaders(row.wire, key),
              });
            },
            noneRefused,
            providerId: row.id,
            providerName: row.name,
            ...(deps.log === undefined ? {} : { log: deps.log }),
          });
        }
        const wire = CHAT_WIRES[row.wire];
        const url = endpoint(row.baseUrl, wire.path);
        return streamChat(deps.fetcher, url, wire.body(req), signal, {
          ...options,
          mapEvents: wire.events(),
          ...(wire.refusal === undefined ? {} : { refusal: wire.refusal }),
          headers: { ...wire.headers(req), ...authHeaders(row.wire, key) },
        });
      };
      try {
        for await (const event of open()) {
          yield event.kind === "error"
            ? { ...event, message: scrubKey(event.message, key) }
            : event;
        }
      } catch (err) {
        if (signal.aborted) return;
        yield {
          kind: "error",
          message: scrubKey(
            `${row.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            key,
          ),
          ...(err instanceof Unanswered
            ? { unanswered: true, ...(err.timedOut ? { timedOut: true } : {}) }
            : {}),
        };
      }
    },
  };
}
