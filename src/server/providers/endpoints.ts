// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Endpoint } from "../../shared/contracts/provider.ts";
import { fetchJson, perMillion } from "./catalog.ts";
import type { ProviderRow } from "./store.ts";
import type { Fetcher } from "./types.ts";
import { authHeaders, endpoint } from "./wires.ts";

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
  const url = endpoint(provider.baseUrl, `/models/${path}/endpoints`);
  return parseEndpoints(
    await fetchJson(fetcher, url, authHeaders("openrouter", key)),
  );
}
