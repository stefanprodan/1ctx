// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Providers: where the models come from. A row names a wire, a base
// URL and a key file; its catalog is read from the wire and cached, and
// a chat request goes out over the wire as one event stream, a
// decisions request as one answer.

import type { CatalogKind } from "../../shared/contracts/decider.ts";
import type {
  CatalogMatch,
  Endpoint,
} from "../../shared/contracts/provider.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadGateway, NotFound } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  CatalogError,
  Catalogs,
  type Fetcher,
  servesDecisions,
} from "./catalog.ts";
import { fetchEndpoints } from "./endpoints.ts";
import { providerFor } from "./provider.ts";
import {
  type AgentsPort,
  type DecidersPort,
  routes,
  type UsagePort,
} from "./routes.ts";
import { type ProviderRow, ProviderStore } from "./store.ts";
import {
  DecisionError,
  type DecisionRequest,
  type Decisions,
  requestDecisions,
} from "./systemone.ts";
import type { ChatEvent, ChatRequest } from "./types.ts";

export { markOf } from "./author.ts";
export {
  AZURE_BASE_URL_PROBLEM,
  azureBaseUrlProblem,
  buildChatBody as buildAzureChatBody,
  parseDeployments,
} from "./azure.ts";
export { azureEvents } from "./azure-stream.ts";
export {
  CatalogError,
  Catalogs,
  type Fetcher,
  fetchCatalog,
  parseCatalog,
  search,
  servesDecisions,
} from "./catalog.ts";
export { fetchEndpoints, parseEndpoints } from "./endpoints.ts";
export {
  buildChatBody as buildGeminiChatBody,
  FOREIGN_SIGNATURE,
  geminiError,
  geminiEvents,
  parseCatalog as parseGeminiCatalog,
} from "./gemini.ts";
export { wireTools } from "./openai.ts";
export { buildChatBody as buildOpenCodeChatBody } from "./opencode.ts";
export { mergeReasoningDetail } from "./openrouter.ts";
export { parseBaseUrl, parseKeyName } from "./parse.ts";
export {
  requestText,
  requestTokens,
  sentMessages,
  wireTokens,
} from "./provider.ts";
export { type ProviderRow, ProviderStore } from "./store.ts";
export { buildChatBody as buildStrictChatBody } from "./strict.ts";
export {
  type Charged,
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionUsage,
  parseDecisions,
  refusedQuestion,
} from "./systemone.ts";
export type {
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  ChatTool,
  ReasoningDetail,
  ToolCall,
  Usage,
} from "./types.ts";

export type ProvidersDeps = {
  db: Db;
  clock: Clock;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  keys: () => string[];
  // what reaches a provider; a test passes a fake
  fetcher: Fetcher;
  log: Log;
  agents: AgentsPort;
  deciders: DecidersPort;
  usage: UsagePort;
};

export type Providers = {
  store: ProviderStore;
  catalogs: Catalogs;
  byId(id: string): ProviderRow | null;
  // one model of a provider's catalog, or null when it is not listed; a
  // catalog that does not answer is the 502 the caller would send anyway,
  // so the catalog's own error stays inside this area
  model(
    provider: ProviderRow,
    id: string,
    kind?: CatalogKind,
  ): Promise<CatalogMatch | null>;
  // who serves a model behind an OpenRouter provider, cheapest first; a
  // provider that does not answer is a 502 like the catalog's
  endpoints(provider: ProviderRow, model: string): Promise<Endpoint[]>;
  // one request over the provider's wire. A provider deleted since the
  // caller named it is the 404 the caller would send, thrown before the
  // stream starts; everything after that is an event, never a throw
  chat(
    providerId: string,
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent>;
  // typed questions answered at the provider's /systemone. A provider
  // deleted since is a 404; anything else that fails, the wire, the
  // key, the signal, a bad answer, is a DecisionError in our words
  decisions(
    providerId: string,
    req: DecisionRequest,
    signal: AbortSignal,
  ): Promise<Decisions>;
  routes: RouteDescriptor[];
};

export function providersArea(deps: ProvidersDeps): Providers {
  const store = new ProviderStore(deps.db);
  const noneRefused = new Set<string>();
  const endpoints = async (provider: ProviderRow, model: string) => {
    const key =
      provider.keyName === null ? null : deps.secret(provider.keyName);
    try {
      return await fetchEndpoints(deps.fetcher, provider, key, model);
    } catch (err) {
      if (err instanceof CatalogError) throw new BadGateway(err.message);
      throw err;
    }
  };
  const catalogs = new Catalogs({
    fetcher: deps.fetcher,
    clock: deps.clock,
    secret: deps.secret,
    log: deps.log,
  });
  return {
    store,
    catalogs,
    byId: (id) => store.byId(id),
    model: async (provider, id, kind) => {
      try {
        return await catalogs.model(provider, id, kind);
      } catch (err) {
        if (err instanceof CatalogError) throw new BadGateway(err.message);
        throw err;
      }
    },
    endpoints,
    chat: (providerId, req, signal) => {
      const row = store.byId(providerId);
      if (row === null) throw new NotFound("no such provider");
      return providerFor(row, { ...deps, noneRefused }).chat(req, signal);
    },
    decisions: async (providerId, req, signal) => {
      const row = store.byId(providerId);
      if (row === null) throw new NotFound("no such provider");
      if (!servesDecisions(row.wire)) {
        throw new DecisionError(`${row.name} serves no decision models`);
      }
      return requestDecisions(row, deps, req, signal);
    },
    routes: routes({
      store,
      catalogs,
      endpoints,
      hasSecret: (name) => deps.secret(name) !== null,
      keys: deps.keys,
      agents: deps.agents,
      deciders: deps.deciders,
      usage: deps.usage,
      clock: deps.clock,
    }),
  };
}
