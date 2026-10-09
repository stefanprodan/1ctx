// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What models.dev says of the models of the dedicated wires, embedded
// in the binary: the window, the tools flag and, for the per-token
// wires, the prices. scripts/models.ts (make models) writes models.json.
// A window and a tools flag belong to the model, so an OpenAI server's
// model is found by name among these; it never gets a price.

import {
  MAX_CONTEXT_LENGTH,
  MIN_CONTEXT_LENGTH,
  type Wire,
} from "../../shared/words.ts";
import data from "./models.json" with { type: "json" };
import type { Usage } from "./types.ts";

// the models.dev provider ids the file holds
export const MODEL_SOURCES = [
  "anthropic",
  "azure",
  "google",
  "opencode-go",
] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

// USD per million tokens; a cache rate the catalog leaves out is the
// input rate, what a provider bills a token it lists no discount for
export type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// a tier applies once the request's prompt passes `above` tokens; the
// tiers ascend
export type ModelPrice = Rates & { tiers: (Rates & { above: number })[] };

// the window is the input cap where models.dev lists one
export type ModelFacts = { contextLength: number | null; tools: boolean };

type ListedRates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type Listed = {
  window?: number;
  tools: boolean;
  canonical?: string;
  price?: ListedRates & { tiers?: (ListedRates & { above: number })[] };
};

const LISTED = data.providers as Record<ModelSource, Record<string, Listed>>;

const listed = (source: ModelSource, model: string): Listed | null =>
  Object.hasOwn(LISTED[source], model) ? LISTED[source][model] : null;

// a window an agent cannot take (an embedding model's 512) is none
const facts = (m: Listed): ModelFacts => ({
  contextLength:
    m.window !== undefined &&
    m.window >= MIN_CONTEXT_LENGTH &&
    m.window <= MAX_CONTEXT_LENGTH
      ? m.window
      : null,
  tools: m.tools,
});

// every model of the sources by its name and its canonical name,
// lowercased; two with one name keep the smaller window, since one too
// large has requests refused, and take tools if either does
const BY_NAME = new Map<string, ModelFacts>();
for (const source of MODEL_SOURCES) {
  for (const [id, m] of Object.entries(LISTED[source])) {
    for (const name of new Set([id.toLowerCase(), m.canonical])) {
      if (name === undefined) continue;
      const had = BY_NAME.get(name);
      const f = facts(m);
      if (
        !had ||
        (f.contextLength !== null &&
          (had.contextLength === null || f.contextLength < had.contextLength))
      ) {
        BY_NAME.set(name, { ...f, tools: f.tools || (had?.tools ?? false) });
      } else if (f.tools && !had.tools) {
        BY_NAME.set(name, { ...had, tools: true });
      }
    }
  }
}

// the models.dev provider of a dedicated wire; the OpenAI wires speak
// for many servers and have none
export function modelSource(wire: Wire): ModelSource | null {
  switch (wire) {
    case "anthropic":
      return "anthropic";
    case "azure":
      return "azure";
    case "gemini":
      return "google";
    case "opencode":
      return "opencode-go";
    default:
      return null;
  }
}

// the model in its own provider, null when models.dev does not list it
export function modelFacts(
  source: ModelSource,
  model: string,
): ModelFacts | null {
  const m = listed(source, model);
  return m ? facts(m) : null;
}

// a model of any host, by the last part of its id (z-ai/glm-5.2 is
// glm-5.2); null when no source lists that name
export function factsByName(model: string): ModelFacts | null {
  const name = model.split("/").pop()?.toLowerCase() ?? "";
  return BY_NAME.get(name) ?? null;
}

const filled = (r: ListedRates): Rates => ({
  input: r.input,
  output: r.output,
  cacheRead: r.cacheRead ?? r.input,
  cacheWrite: r.cacheWrite ?? r.input,
});

// null when models.dev has no price for the model
export function modelPrice(
  source: ModelSource,
  model: string,
): ModelPrice | null {
  const price = listed(source, model)?.price;
  if (!price) return null;
  return {
    ...filled(price),
    tiers: (price.tiers ?? []).map((t) => ({ above: t.above, ...filled(t) })),
  };
}

// the reply's cost, else 0 on opencode, else priced at the highest tier
// passed
export function costOf(
  usage: Pick<
    Usage,
    | "promptTokens"
    | "completionTokens"
    | "cachedTokens"
    | "cacheWriteTokens"
    | "cost"
  >,
  wire: Wire | null,
  price: ModelPrice | null,
): number | null {
  if (usage.cost !== null) return usage.cost;
  if (wire === "opencode") return 0;
  if (price === null) return null;
  const prompt = usage.promptTokens;
  const read = Math.min(usage.cachedTokens ?? 0, prompt);
  const write = Math.min(usage.cacheWriteTokens ?? 0, prompt - read);
  let rates: Rates = price;
  for (const tier of price.tiers) if (prompt > tier.above) rates = tier;
  return (
    ((prompt - read - write) * rates.input +
      read * rates.cacheRead +
      write * rates.cacheWrite +
      usage.completionTokens * rates.output) /
    1_000_000
  );
}
