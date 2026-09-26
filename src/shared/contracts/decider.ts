// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider as the wire exposes it: a named decision model that answers
// typed questions about a state with probabilities and no text. What
// the catalog said about the model is kept from when it was picked.

// the wires whose servers answer decisions at <baseUrl>/systemone
export const DECIDER_WIRES = ["openrouter", "openai-compatible"] as const;

// which list a provider's catalog search reads: the chat models, or the
// decision models at /models?output_modalities=decisions
export const CATALOG_KINDS = ["chat", "decisions"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export function isCatalogKind(value: unknown): value is CatalogKind {
  return (
    typeof value === "string" &&
    (CATALOG_KINDS as readonly string[]).includes(value)
  );
}

export type DeciderSummary = {
  id: string;
  name: string;
  providerId: string;
  model: string;
  // the window in tokens and the input price in USD per million tokens,
  // null when the catalog did not say
  contextLength: number | null;
  promptPrice: number | null;
  // the decider a decision asks unless it names another: the one an
  // admin marked, else the first created
  default: boolean;
  createdAt: number;
};
