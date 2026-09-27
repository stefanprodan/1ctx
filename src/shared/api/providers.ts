// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the provider routes, all for admins.

import type {
  CatalogMatch,
  Endpoint,
  ProviderSummary,
} from "../contracts/provider.ts";
import type { Wire } from "../words.ts";

// GET /api/providers
export type ProvidersResponse = {
  providers: ProviderSummary[];
  keys: string[];
};

// POST /api/providers answers the row
export type ProviderResponse = { provider: ProviderSummary };
export type CreateProviderRequest = {
  name: string;
  wire: Wire;
  baseUrl: string;
  keyName: string | null;
};

// GET /api/providers/:id/catalog?q=&kind=: the matches for what was
// typed, in the chat catalog by default or the decisions catalog
export type CatalogResponse = { matches: CatalogMatch[] };

// GET /api/providers/:id/usage, the provider's last 30 days: the turns
// and runs of every agent on it, their tokens, and the cost, null when
// rounds ran and none was priced
export type ProviderUsageResponse = {
  since: number;
  until: number;
  sends: number;
  tokens: number;
  cost: number | null;
};

// GET /api/providers/:id/endpoints?model=: who serves the model behind
// an OpenRouter provider, cheapest first
export type EndpointsResponse = { endpoints: Endpoint[] };
