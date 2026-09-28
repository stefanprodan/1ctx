// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type { SendTotalsResponse } from "../../shared/api/admin.ts";
import type {
  CatalogResponse,
  CreateProviderRequest,
  EndpointsResponse,
  ProviderResponse,
  ProvidersResponse,
} from "../../shared/api/providers.ts";
import type { CatalogKind } from "../../shared/contracts/decider.ts";
import type {
  CatalogMatch,
  Endpoint,
  ProviderSummary,
} from "../../shared/contracts/provider.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { usageSlot } from "./slot.ts";

export const providers = signal<ProviderSummary[] | null>(null);
export const keys = signal<string[]>([]);
export const providersError = signal<Failure | null>(null);
export const providerUsage = usageSlot<SendTotalsResponse>(
  (id) => `/api/providers/${encodeURIComponent(id)}/usage`,
);
export const loadProviderUsage = providerUsage.load;

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  providers.value = null;
  keys.value = [];
  providersError.value = null;
});

// a write can land while a load is in flight: only the latest word lands
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
  kind: CatalogKind = "chat",
): Promise<CatalogMatch[]> {
  const body = await api<CatalogResponse>(
    `/api/providers/${encodeURIComponent(id)}/catalog?q=${encodeURIComponent(q)}${kind === "chat" ? "" : `&kind=${kind}`}`,
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
