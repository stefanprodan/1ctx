// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The providers entity: the admin's list, loaded once per signed-in
// user and dropped with them, and the calls that change it. A write
// answers the new list from the server's row, so what shows is what
// was saved. The catalog search is a plain call: its answer belongs to
// the form that asked, not here.

import { effect, signal } from "@preact/signals";
import type {
  CatalogResponse,
  CreateProviderRequest,
  ProviderResponse,
  ProvidersResponse,
} from "../../shared/api/providers.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../shared/contracts/provider.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const providers = signal<ProviderSummary[] | null>(null);
export const providersError = signal<string | null>(null);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  providers.value = null;
  providersError.value = null;
});

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function loadProviders(): Promise<void> {
  const forUser = owner;
  providersError.value = null;
  try {
    const body = await api<ProvidersResponse>("/api/providers");
    if (owner === forUser) providers.value = body.providers;
  } catch (err) {
    if (owner === forUser) providersError.value = reason(err);
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
  if (owner === forUser) {
    providers.value = [...(providers.value ?? []), provider];
  }
  return provider;
}

export async function deleteProvider(id: string): Promise<void> {
  const forUser = owner;
  await api(`/api/providers/${encodeURIComponent(id)}`, "DELETE");
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
