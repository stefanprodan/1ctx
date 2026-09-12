// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Providers: where the models come from. A row names a wire, a base
// URL and a key file; its catalog is read from the wire and cached.

export {
  CatalogError,
  Catalogs,
  type Fetcher,
  fetchCatalog,
  parseCatalog,
  search,
} from "./catalog.ts";
export { type RoutesDeps, routes } from "./routes.ts";
export { type ProviderRow, ProviderStore, summary } from "./store.ts";
