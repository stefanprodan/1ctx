// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider as the wire exposes it: where the models come from. The
// key's value never rides here; only whether its file is there. A
// provider is added and deleted, never changed.

import type { Wire } from "../words.ts";

export type ProviderSummary = {
  id: string;
  name: string;
  wire: Wire;
  baseUrl: string;
  // the secret file's name, null for a server with no key
  keyName: string | null;
  hasKey: boolean;
  createdAt: number;
};

// what the catalog says about one model: the window, the prices in USD
// per million tokens (null when the catalog did not say) and the flags.
// A catalog that lists only ids leaves `described` false, and an admin
// states the window and the tools flag on the agent in its place; the
// server fills both from models.dev where it lists the model, as a
// suggestion. `listedAs` is the model's models.dev id on a dedicated
// wire (an Azure deployment's model), which an agent keeps for its
// cost; absent on the other wires. `outputLimit` is the most a reply
// may hold, where the catalog says (anthropic)
export type CatalogMatch = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  tools: boolean;
  reasoning: boolean;
  // the model always thinks: a request that turns thinking off is refused
  thinkingRequired: boolean;
  // the catalog reliably says whether the model thinks, so reasoning
  // false means it never does; OpenRouter, Gemini and Anthropic do
  reasoningKnown: boolean;
  described: boolean;
  listedAs?: string;
  outputLimit?: number;
};

// one provider serving a model behind OpenRouter: the tag a request
// names in provider.order, the prices in USD per million tokens and the
// discount as a fraction off (0.5 is half)
export type Endpoint = {
  tag: string;
  name: string;
  quantization: string | null;
  promptPrice: number | null;
  completionPrice: number | null;
  discount: number;
  tools: boolean;
  reasoning: boolean;
};
