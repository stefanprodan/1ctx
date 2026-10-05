// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Writes src/server/providers/models.json from the models.dev catalog
// for the providers of the dedicated wires: each model's window, tools
// flag and canonical name, and for the per-token ones its prices in USD
// per million tokens. OpenRouter describes and prices its own; OpenCode
// Go is a flat plan, so it carries no prices. Run by hand (make
// models); the file is committed and embedded.

import { join } from "node:path";

const SOURCE = "https://models.dev/api.json";
const PROVIDERS = ["azure", "google", "opencode-go"];
const PRICED = new Set(["azure", "google"]);
const OUT = join(import.meta.dir, "../src/server/providers/models.json");

type Cost = {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  tiers?: { tier?: { type?: unknown; size?: unknown } }[];
  context_over_200k?: Cost;
};

type Rates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

const price = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

function rates(cost: Cost): Rates | null {
  const input = price(cost.input);
  const output = price(cost.output);
  if (input === undefined || output === undefined) return null;
  const out: Rates = { input, output };
  const read = price(cost.cache_read);
  const write = price(cost.cache_write);
  if (read !== undefined) out.cacheRead = read;
  if (write !== undefined) out.cacheWrite = write;
  return out;
}

// tiers win over context_over_200k, the older field: a model listing
// both (GPT-6.1 Sol: 272K) would otherwise pay the higher price from 200K
function tiers(cost: Cost): (Rates & { above: number })[] {
  const listed = (cost.tiers ?? []).flatMap((t) => {
    const r = rates(t as Cost);
    const size = price(t.tier?.size);
    if (t.tier?.type !== "context" || !r || !size) return [];
    return [{ above: size, ...r }];
  });
  if (listed.length === 0 && cost.context_over_200k) {
    const r = rates(cost.context_over_200k);
    if (r) listed.push({ above: 200_000, ...r });
  }
  return listed.sort((a, b) => a.above - b.above);
}

export type Model = {
  cost?: Cost;
  tool_call?: unknown;
  limit?: { context?: unknown; input?: unknown };
  canonical_model_id?: unknown;
};

// the input cap where one is listed: Azure takes 922K of Sol's 1.05M
// window as input, the rest is room for the reply
const windowOf = (m: Model) =>
  price(m.limit?.input) || price(m.limit?.context) || undefined;

// the file's providers from the catalog's
export function extract(
  catalog: Record<string, { models?: Record<string, Model> }>,
): Record<string, Record<string, unknown>> {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const id of PROVIDERS) {
    const models = catalog[id]?.models;
    if (!models) throw new Error(`${id} is not in the catalog`);
    const listed: Record<string, unknown> = {};
    for (const name of Object.keys(models).sort()) {
      const m = models[name];
      const base = PRICED.has(id) && m.cost ? rates(m.cost) : null;
      const window = windowOf(m);
      if (!base && window === undefined) continue;
      const above = m.cost && base ? tiers(m.cost) : [];
      // the last part of the canonical id, the name another host serves
      // the model under (openai/gpt-6.1-sol is gpt-6.1-sol)
      const canonical =
        typeof m.canonical_model_id === "string"
          ? m.canonical_model_id.split("/").pop()?.toLowerCase()
          : undefined;
      listed[name] = {
        ...(window !== undefined && { window }),
        tools: m.tool_call === true,
        ...(canonical && canonical !== name.toLowerCase() && { canonical }),
        ...(base && {
          price: above.length > 0 ? { ...base, tiers: above } : base,
        }),
      };
    }
    providers[id] = listed;
  }
  return providers;
}

if (import.meta.main) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
  const providers = extract(await res.json());
  await Bun.write(OUT, `${JSON.stringify({ source: SOURCE, providers })}\n`);
  const count = Object.values(providers).reduce(
    (n, p) => n + Object.keys(p).length,
    0,
  );
  console.log(`${count} models from ${PROVIDERS.length} providers`);
}
