// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Catalogs are parsed once, cached an hour per provider and searched
// server-side so the browser never sees the whole list. The wire picks
// the catalog's shape and authentication.

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Clock } from "../lib/clock.ts";
import { parseCatalog as parseGeminiCatalog } from "./gemini.ts";
import type { ProviderRow } from "./store.ts";
import { CatalogError, type Fetcher } from "./types.ts";

export { CatalogError, type Fetcher } from "./types.ts";

export const CATALOG_TTL_MS = 60 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 10_000;
export const SEARCH_LIMIT = 20;
// more than a catalog: what is dropped unread past it
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

// OpenRouter prices are USD per token as a string; the wire carries
// USD per million tokens, or null when the catalog did not say
const perMillion = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toPrecision(12));
};

export function parseCatalog(body: unknown): CatalogMatch[] {
  const out: CatalogMatch[] = [];
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  const seen = new Set<string>();
  for (const m of data as Record<string, unknown>[]) {
    if (typeof m?.id !== "string" || m.id === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    // OpenRouter lists supported_parameters, mlx-serve capabilities and
    // Groq supported_features; NIM and OpenAI list none of them
    const lists = [
      m.supported_parameters,
      m.capabilities,
      m.supported_features,
    ].filter((list): list is unknown[] => Array.isArray(list));
    const params = lists.flat();
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const contextLength =
      typeof m.context_length === "number" && m.context_length > 0
        ? m.context_length
        : null;
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name !== "" ? m.name : m.id,
      contextLength,
      promptPrice: perMillion(pricing.prompt),
      completionPrice: perMillion(pricing.completion),
      tools: params.includes("tools") || params.includes("tool_use"),
      reasoning: params.includes("reasoning"),
      described: contextLength !== null || lists.length > 0,
    });
  }
  return out;
}

// the body read chunk by chunk and refused past the cap, so a provider
// cannot fill the process however long it talks
async function readCapped(res: Response, max: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new CatalogError("the catalog is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchCatalog(
  fetcher: Fetcher,
  provider: Pick<ProviderRow, "wire" | "baseUrl">,
  key: string | null,
): Promise<CatalogMatch[]> {
  let res: Response;
  const gemini = provider.wire === "gemini";
  const path = gemini ? "/models?pageSize=1000" : "/models";
  const headers: Record<string, string> =
    key === null
      ? {}
      : gemini
        ? { "x-goog-api-key": key }
        : { authorization: `Bearer ${key}` };
  try {
    res = await fetcher(`${provider.baseUrl.replace(/\/+$/, "")}${path}`, {
      headers,
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CatalogError(
      `the provider did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new CatalogError(`the provider answered ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await readCapped(res, MAX_CATALOG_BYTES));
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError("the provider did not answer with JSON");
  }
  const models = gemini ? parseGeminiCatalog(body) : parseCatalog(body);
  if (models.length === 0) throw new CatalogError("the catalog is empty");
  return models;
}

// the matches for what was typed: an id that starts with it first,
// then the rest whose id or name contains it, case-insensitive
export function search(
  models: CatalogMatch[],
  q: string,
  limit = SEARCH_LIMIT,
): CatalogMatch[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return [];
  const first: CatalogMatch[] = [];
  const rest: CatalogMatch[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (id.startsWith(needle)) first.push(m);
    else if (id.includes(needle) || m.name.toLowerCase().includes(needle)) {
      rest.push(m);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

type Cached = { at: number; models: CatalogMatch[] };

// one cache per provider, filled on the first question and kept an
// hour; one fetch in flight at a time, shared by whoever asks while it
// runs. The key is read at each fetch, so a file added later is seen.
export class Catalogs {
  private readonly cached = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<CatalogMatch[]>>();

  constructor(
    private readonly deps: {
      fetcher: Fetcher;
      clock: Clock;
      secret: (name: string) => string | null;
      ttlMs?: number;
    },
  ) {}

  models(provider: ProviderRow): Promise<CatalogMatch[]> {
    const hit = this.cached.get(provider.id);
    const ttl = this.deps.ttlMs ?? CATALOG_TTL_MS;
    if (hit && this.deps.clock() - hit.at < ttl) {
      return Promise.resolve(hit.models);
    }
    const running = this.inflight.get(provider.id);
    if (running) return running;
    const key =
      provider.keyName === null ? null : this.deps.secret(provider.keyName);
    // kept only while it is still the fetch wanted: a forget() while it
    // ran means the provider is gone and nothing is cached for it
    const run = fetchCatalog(this.deps.fetcher, provider, key)
      .then((models) => {
        if (this.inflight.get(provider.id) === run) {
          this.cached.set(provider.id, { at: this.deps.clock(), models });
        }
        return models;
      })
      .finally(() => {
        if (this.inflight.get(provider.id) === run) {
          this.inflight.delete(provider.id);
        }
      });
    this.inflight.set(provider.id, run);
    return run;
  }

  async search(provider: ProviderRow, q: string): Promise<CatalogMatch[]> {
    return search(await this.models(provider), q);
  }

  // one model by id, or null when the catalog does not list it
  async model(provider: ProviderRow, id: string): Promise<CatalogMatch | null> {
    const models = await this.models(provider);
    return models.find((m) => m.id === id) ?? null;
  }

  forget(providerId: string): void {
    this.cached.delete(providerId);
    this.inflight.delete(providerId);
  }
}
