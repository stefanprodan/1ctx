// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who serves a model behind OpenRouter: the endpoints list an admin
// picks a preferred upstream from. Read on demand, never cached, since
// it is asked once per model picked in the form.

import type { Endpoint } from "../../shared/contracts/provider.ts";
import {
  CATALOG_TIMEOUT_MS,
  MAX_CATALOG_BYTES,
  perMillion,
  readCapped,
} from "./catalog.ts";
import type { ProviderRow } from "./store.ts";
import { CatalogError, type Fetcher } from "./types.ts";

const sum = (e: Endpoint): number =>
  (e.promptPrice ?? Number.POSITIVE_INFINITY) +
  (e.completionPrice ?? Number.POSITIVE_INFINITY);

// OpenRouter's prices already carry the discount, so the order is by
// what a turn costs; a tag listed twice is one choice
export function parseEndpoints(body: unknown): Endpoint[] {
  const data = (body as { data?: { endpoints?: unknown } })?.data;
  const list = data?.endpoints;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Endpoint[] = [];
  for (const e of list as Record<string, unknown>[]) {
    if (typeof e?.tag !== "string" || e.tag === "" || seen.has(e.tag)) {
      continue;
    }
    seen.add(e.tag);
    const pricing = (e.pricing ?? {}) as Record<string, unknown>;
    const params = Array.isArray(e.supported_parameters)
      ? e.supported_parameters
      : [];
    const discount =
      typeof pricing.discount === "number" &&
      pricing.discount > 0 &&
      pricing.discount < 1
        ? pricing.discount
        : 0;
    out.push({
      tag: e.tag,
      name:
        typeof e.provider_name === "string" && e.provider_name !== ""
          ? e.provider_name
          : e.tag,
      // "unknown" says nothing the absence does not
      quantization:
        typeof e.quantization === "string" &&
        e.quantization !== "" &&
        e.quantization !== "unknown"
          ? e.quantization
          : null,
      promptPrice: perMillion(pricing.prompt),
      completionPrice: perMillion(pricing.completion),
      discount,
      tools: params.includes("tools"),
      reasoning: params.includes("reasoning"),
    });
  }
  return out.sort((a, b) => sum(a) - sum(b) || a.name.localeCompare(b.name));
}

export async function fetchEndpoints(
  fetcher: Fetcher,
  provider: Pick<ProviderRow, "baseUrl">,
  key: string | null,
  model: string,
): Promise<Endpoint[]> {
  const path = model.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await fetcher(
      `${provider.baseUrl.replace(/\/+$/, "")}/models/${path}/endpoints`,
      {
        headers: key === null ? {} : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new CatalogError(
      `the provider did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new CatalogError(`the provider answered ${res.status}`);
  try {
    return parseEndpoints(JSON.parse(await readCapped(res, MAX_CATALOG_BYTES)));
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError("the provider did not answer with JSON");
  }
}
