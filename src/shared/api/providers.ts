// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the provider routes, all for admins.

import type { CatalogMatch, ProviderSummary } from "../contracts/provider.ts";
import type { Wire } from "../words.ts";

// GET /api/providers
export type ProvidersResponse = { providers: ProviderSummary[] };

// POST /api/providers answers the row
export type ProviderResponse = { provider: ProviderSummary };
export type CreateProviderRequest = {
  name: string;
  wire: Wire;
  baseUrl: string;
  keyName: string | null;
};

// GET /api/providers/:id/catalog?q=: the matches for what was typed
export type CatalogResponse = { matches: CatalogMatch[] };
