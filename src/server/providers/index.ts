// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Providers: where the models come from. A row names a wire, a base
// URL and a key file; its catalog is read from the wire and cached, and
// a chat request goes out over the wire as one event stream.

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadGateway, NotFound } from "../lib/errors.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { CatalogError, Catalogs, type Fetcher } from "./catalog.ts";
import { providerFor } from "./provider.ts";
import { type AgentsPort, routes } from "./routes.ts";
import { type ProviderRow, ProviderStore } from "./store.ts";
import type { ChatEvent, ChatRequest } from "./types.ts";

export {
  CatalogError,
  Catalogs,
  type Fetcher,
  fetchCatalog,
  parseCatalog,
  search,
} from "./catalog.ts";
export {
  buildChatBody as buildGeminiChatBody,
  geminiError,
  geminiEvents,
  parseCatalog as parseGeminiCatalog,
} from "./gemini.ts";
export { wireTools } from "./openai.ts";
export { mergeReasoningDetail } from "./openrouter.ts";
export { parseKeyName, RESERVED_KEYS } from "./parse.ts";
export { type AgentsPort, type RoutesDeps, routes } from "./routes.ts";
export { type ProviderRow, ProviderStore, summary } from "./store.ts";
export type {
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  ChatTool,
  Provider,
  ReasoningDetail,
  ToolCall,
  Usage,
} from "./types.ts";

export type ProvidersDeps = {
  db: Db;
  clock: Clock;
  // the secrets port: the bare value or null
  secret: (name: string) => string | null;
  // what reaches a provider; a test passes a fake
  fetcher: Fetcher;
  agents: AgentsPort;
};

export type Providers = {
  store: ProviderStore;
  catalogs: Catalogs;
  byId(id: string): ProviderRow | null;
  // one model of a provider's catalog, or null when it is not listed; a
  // catalog that does not answer is the 502 the caller would send anyway,
  // so the catalog's own error stays inside this area
  model(provider: ProviderRow, id: string): Promise<CatalogMatch | null>;
  // one request over the provider's wire. A provider deleted since the
  // caller named it is the 404 the caller would send, thrown before the
  // stream starts; everything after that is an event, never a throw
  chat(
    providerId: string,
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent>;
  routes: RouteDescriptor[];
};

export function providersArea(deps: ProvidersDeps): Providers {
  const store = new ProviderStore(deps.db);
  const catalogs = new Catalogs({
    fetcher: deps.fetcher,
    clock: deps.clock,
    secret: deps.secret,
  });
  return {
    store,
    catalogs,
    byId: (id) => store.byId(id),
    model: async (provider, id) => {
      try {
        return await catalogs.model(provider, id);
      } catch (err) {
        if (err instanceof CatalogError) throw new BadGateway(err.message);
        throw err;
      }
    },
    chat: (providerId, req, signal) => {
      const row = store.byId(providerId);
      if (row === null) throw new NotFound("no such provider");
      return providerFor(row, deps).chat(req, signal);
    },
    routes: routes({
      store,
      catalogs,
      hasSecret: (name) => deps.secret(name) !== null,
      agents: deps.agents,
      clock: deps.clock,
    }),
  };
}
