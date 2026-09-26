// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The providers entity: the admin's list, loaded when its page is
// reached and dropped with the signed-in user, and the calls that
// change it. A write
// answers the new list from the server's row, so what shows is what
// was saved. The catalog search and a model's endpoints are plain
// calls: their answers belong to the form that asked, not here.

import { effect, signal } from "@preact/signals";
import type {
  CatalogResponse,
  CreateProviderRequest,
  EndpointsResponse,
  ProviderResponse,
  ProvidersResponse,
} from "../../shared/api/providers.ts";
import type {
  CatalogMatch,
  Endpoint,
  ProviderSummary,
} from "../../shared/contracts/provider.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const providers = signal<ProviderSummary[] | null>(null);
export const keys = signal<string[]>([]);
export const providersError = signal<Failure | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  providers.value = null;
  keys.value = [];
  providersError.value = null;
});

// a load's answer is kept only when it is still the one wanted: for
// the signed-in user of the moment and the latest word on the list, a
// failure included, since a route arrival reloads and a write can land
// while a load is in flight
let turn = 0;

export async function loadProviders(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  providersError.value = null;
  try {
    const body = await api<ProvidersResponse>("/api/providers");
    if (owner === forUser && turn === mine) {
      providers.value = body.providers;
      keys.value = body.keys;
    }
  } catch (err) {
    if (owner === forUser && turn === mine) providersError.value = failure(err);
  }
}

export async function createProvider(
  body: CreateProviderRequest,
): Promise<ProviderSummary> {
  const forUser = owner;
  const { provider } = await api<ProviderResponse>(
    "/api/providers",
    "POST",
    body,
  );
  turn++;
  if (owner === forUser) {
    providers.value = [...(providers.value ?? []), provider];
  }
  return provider;
}

export async function deleteProvider(id: string): Promise<void> {
  const forUser = owner;
  await api(`/api/providers/${encodeURIComponent(id)}`, "DELETE");
  turn++;
  if (owner === forUser) {
    providers.value = (providers.value ?? []).filter((p) => p.id !== id);
  }
}

export async function searchCatalog(
  id: string,
  q: string,
): Promise<CatalogMatch[]> {
  const body = await api<CatalogResponse>(
    `/api/providers/${encodeURIComponent(id)}/catalog?q=${encodeURIComponent(q)}`,
  );
  return body.matches;
}

export async function listEndpoints(
  id: string,
  model: string,
): Promise<Endpoint[]> {
  const body = await api<EndpointsResponse>(
    `/api/providers/${encodeURIComponent(id)}/endpoints?model=${encodeURIComponent(model)}`,
  );
  return body.endpoints;
}
