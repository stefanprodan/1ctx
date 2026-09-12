// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The providers, all for admins: the list, a new one, its deletion and
// the catalog search. A provider an agent runs on cannot go; whether
// one does is the agents port's answer.

import type {
  CatalogResponse,
  ProviderResponse,
  ProvidersResponse,
} from "../../shared/api/providers.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadGateway, Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { CatalogError, type Catalogs } from "./catalog.ts";
import { parseProvider, parseQuery } from "./parse.ts";
import { type ProviderRow, type ProviderStore, summary } from "./store.ts";

export type RoutesDeps = {
  store: ProviderStore;
  catalogs: Catalogs;
  // the secrets port: whether the key file is there
  hasSecret: (name: string) => boolean;
  // the agents port: whether an agent runs on the provider
  inUse: (providerId: string) => boolean;
  clock: Clock;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const show = (p: ProviderRow) =>
    summary(p, p.keyName !== null && deps.hasSecret(p.keyName));
  const find = (id: string) => {
    const provider = deps.store.byId(id);
    if (!provider) throw new NotFound("no such provider");
    return provider;
  };
  return [
    {
      method: "GET",
      path: "/api/providers",
      policy: "admin",
      handle() {
        const body: ProvidersResponse = {
          providers: deps.store.list().map(show),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/providers",
      policy: "admin",
      async handle(req) {
        const fields = parseProvider(await jsonBody(req));
        if (deps.store.byName(fields.name)) {
          throw new Conflict(`a provider named ${fields.name} exists`);
        }
        const provider = deps.store.create({ ...fields, now: deps.clock() });
        const body: ProviderResponse = { provider: show(provider) };
        return json(body, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/providers/:id",
      policy: "admin",
      handle(_req, ctx) {
        const provider = find(ctx.params.id);
        if (deps.inUse(provider.id)) {
          throw new Conflict(`an agent runs on ${provider.name}`);
        }
        deps.store.delete(provider.id);
        deps.catalogs.forget(provider.id);
        return json({});
      },
    },
    {
      method: "GET",
      path: "/api/providers/:id/catalog",
      policy: "admin",
      async handle(_req, ctx) {
        const provider = find(ctx.params.id);
        const q = parseQuery(ctx.url);
        let matches: CatalogResponse["matches"] = [];
        if (q !== "") {
          try {
            matches = await deps.catalogs.search(provider, q);
          } catch (err) {
            if (err instanceof CatalogError) throw new BadGateway(err.message);
            throw err;
          }
        }
        const body: CatalogResponse = { matches };
        return json(body);
      },
    },
  ];
}
