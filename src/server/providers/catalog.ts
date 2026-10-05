// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  CATALOG_KINDS,
  type CatalogKind,
  DECIDER_WIRES,
} from "../../shared/contracts/decider.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Wire } from "../../shared/words.ts";
import { readStream } from "../lib/body.ts";
import { type Clock, HOUR_MS } from "../lib/clock.ts";
import { BadGateway, messageOf } from "../lib/errors.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { azureUrls, parseDeployments } from "./azure.ts";
import { parseCatalog as parseGeminiCatalog } from "./gemini.ts";
import { factsByName, modelFacts, modelPrice, modelSource } from "./models.ts";
import { keyOf } from "./provider.ts";
import type { ProviderRow } from "./store.ts";
import { CatalogError, type Fetcher } from "./types.ts";
import { authHeaders, endpoint } from "./wires.ts";

export { CatalogError, type Fetcher } from "./types.ts";

const CATALOG_TTL_MS = HOUR_MS;
const CATALOG_TIMEOUT_MS = 10_000;
const SEARCH_LIMIT = 20;
// more than a catalog: what is dropped unread past it
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

// OpenRouter prices are USD per token as a string; the wire carries
// USD per million tokens, or null when the catalog did not say
export const perMillion = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toPrecision(12));
};

// TypeSafe's list, which kev.serve answers too: a name per model and
// nothing a match has a field for
function parseNamed(models: unknown[]): CatalogMatch[] {
  const out: CatalogMatch[] = [];
  const seen = new Set<string>();
  for (const m of models as Record<string, unknown>[]) {
    const id = m?.name;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: id,
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      tools: false,
      reasoning: false,
      thinkingRequired: false,
      reasoningKnown: false,
      described: false,
    });
  }
  return out;
}

export function parseCatalog(body: unknown): CatalogMatch[] {
  const out: CatalogMatch[] = [];
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    const models = (body as { models?: unknown })?.models;
    return Array.isArray(models) ? parseNamed(models) : out;
  }
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
      // OpenRouter alone says so, as reasoning.mandatory
      thinkingRequired:
        (m.reasoning as { mandatory?: unknown } | undefined)?.mandatory ===
        true,
      // OpenRouter's parameters always name reasoning when the model
      // thinks; mlx-serve leaves it out of a thinking model's capabilities
      reasoningKnown: Array.isArray(m.supported_parameters),
      described: contextLength !== null || lists.length > 0,
    });
  }
  return out;
}

// the body read chunk by chunk and refused past the cap, so a provider
// cannot fill the process however long it talks

// a server that ignores the query answers its whole list, which is
// what a local decisions server serves
const DECISIONS_PATH = "/models?output_modalities=decisions";

export const servesDecisions = (wire: string): boolean =>
  (DECIDER_WIRES as readonly string[]).includes(wire);

// a catalog that does not answer is the 502 a route sends
export async function gateway<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof CatalogError) throw new BadGateway(err.message);
    throw err;
  }
}

// one GET within the catalog's wait, its body capped and read as JSON
export async function fetchJson(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetcher(url, { headers, signal });
  } catch (err) {
    throw new CatalogError(`the provider did not answer: ${messageOf(err)}`);
  }
  if (!res.ok) throw new CatalogError(`the provider answered ${res.status}`);
  try {
    const bytes = await readStream(res.body, MAX_CATALOG_BYTES, signal);
    if (bytes === null) throw new CatalogError("the catalog is too large");
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError("the provider did not answer with JSON");
  }
}

type WireCatalog = {
  url(baseUrl: string): string;
  parse(body: unknown): CatalogMatch[];
};

const OPENAI_CATALOG: WireCatalog = {
  url: (base) => endpoint(base, "/models"),
  parse: parseCatalog,
};

const CATALOGS: Record<Wire, WireCatalog> = {
  openrouter: OPENAI_CATALOG,
  "openai-compatible": OPENAI_CATALOG,
  "openai-strict": OPENAI_CATALOG,
  opencode: OPENAI_CATALOG,
  gemini: {
    url: (base) => endpoint(base, "/models?pageSize=1000"),
    parse: parseGeminiCatalog,
  },
  azure: { url: (base) => azureUrls(base).catalog, parse: parseDeployments },
};

export async function fetchCatalog(
  fetcher: Fetcher,
  provider: Pick<ProviderRow, "wire" | "baseUrl">,
  key: string | null,
  kind: CatalogKind = "chat",
): Promise<CatalogMatch[]> {
  if (kind === "decisions" && !servesDecisions(provider.wire)) {
    throw new CatalogError("the provider serves no decision models");
  }
  const catalog = CATALOGS[provider.wire];
  const url =
    kind === "decisions"
      ? endpoint(provider.baseUrl, DECISIONS_PATH)
      : catalog.url(provider.baseUrl);
  const body = await fetchJson(
    fetcher,
    url,
    authHeaders(provider.wire, key, "catalog"),
  );
  const models = catalog.parse(body);
  if (models.length === 0) throw new CatalogError("the catalog is empty");
  return kind === "chat"
    ? models.map((m) => withModelsDev(m, provider.wire))
    : models;
}

// models.dev's window, tools and price for a chat row (docs/providers.md)
export function withModelsDev(m: CatalogMatch, wire: Wire): CatalogMatch {
  const { listedAs: _, ...row } = m;
  const source = modelSource(wire);
  if (source === null) {
    const facts = m.described ? null : factsByName(m.id);
    return facts === null ? row : { ...row, ...facts };
  }
  const id = m.listedAs ?? m.id;
  const facts = modelFacts(source, id);
  const price = modelPrice(source, id);
  const out: CatalogMatch = { ...row, listedAs: id };
  if (!m.described && facts !== null) Object.assign(out, facts);
  if (price !== null && m.promptPrice === null) {
    out.promptPrice = price.input;
    out.completionPrice = price.output;
  }
  return out;
}

export function search(
  models: CatalogMatch[],
  q: string,
  limit = SEARCH_LIMIT,
): CatalogMatch[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return [];
  const first: CatalogMatch[] = [];
  const rest: CatalogMatch[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    if (!words.every((w) => id.includes(w) || name.includes(w))) continue;
    if (id.startsWith(words[0])) first.push(m);
    else rest.push(m);
  }
  return [...first, ...rest].slice(0, limit);
}

type Cached = { at: number; models: CatalogMatch[] };

const cacheKey = (providerId: string, kind: CatalogKind) =>
  `${providerId}\n${kind}`;

// one cache per provider and kind, filled on the first question and
// kept an hour; one fetch in flight at a time, shared by whoever asks
// while it runs. The key is read at each fetch, so a file added later
// is seen.
export class Catalogs {
  private readonly cached = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<CatalogMatch[]>>();

  constructor(
    private readonly deps: {
      fetcher: Fetcher;
      clock: Clock;
      secret: (name: string) => string | null;
      log?: Log;
      ttlMs?: number;
    },
  ) {}

  models(
    provider: ProviderRow,
    kind: CatalogKind = "chat",
  ): Promise<CatalogMatch[]> {
    const id = cacheKey(provider.id, kind);
    const hit = this.cached.get(id);
    const ttl = this.deps.ttlMs ?? CATALOG_TTL_MS;
    if (hit && this.deps.clock() - hit.at < ttl) {
      return Promise.resolve(hit.models);
    }
    const running = this.inflight.get(id);
    if (running) return running;
    const key = keyOf(provider, this.deps.secret);
    // kept only while it is still the fetch wanted: a forget() while it
    // ran means the provider is gone and nothing is cached for it
    const run = fetchCatalog(this.deps.fetcher, provider, key, kind)
      .then((models) => {
        if (this.inflight.get(id) === run) {
          this.cached.set(id, { at: this.deps.clock(), models });
          this.deps.log?.info("catalog refreshed", {
            provider: provider.name,
            kind,
            models: models.length,
          });
        }
        return models;
      })
      .catch((error) => {
        this.deps.log?.warn("catalog refresh failed", {
          provider: provider.name,
          kind,
          ...errorFields(error, false),
        });
        throw error;
      })
      .finally(() => {
        if (this.inflight.get(id) === run) this.inflight.delete(id);
      });
    this.inflight.set(id, run);
    return run;
  }

  async search(
    provider: ProviderRow,
    q: string,
    kind: CatalogKind = "chat",
  ): Promise<CatalogMatch[]> {
    return search(await this.models(provider, kind), q);
  }

  // one model by id, or null when the catalog does not list it
  async model(
    provider: ProviderRow,
    id: string,
    kind: CatalogKind = "chat",
  ): Promise<CatalogMatch | null> {
    const models = await this.models(provider, kind);
    return models.find((m) => m.id === id) ?? null;
  }

  forget(providerId: string): void {
    for (const kind of CATALOG_KINDS) {
      this.cached.delete(cacheKey(providerId, kind));
      this.inflight.delete(cacheKey(providerId, kind));
    }
  }
}
