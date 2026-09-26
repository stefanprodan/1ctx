// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the decider routes, all for admins.

import type { DeciderSummary } from "../contracts/decider.ts";

// GET /api/deciders, oldest first
export type DecidersResponse = { deciders: DeciderSummary[] };

// POST /api/deciders and PATCH /api/deciders/:id answer the row
export type DeciderResponse = { decider: DeciderSummary };

// the model is an id the provider's decisions catalog lists, on an
// openrouter or openai-compatible provider
export type SaveDeciderRequest = {
  name: string;
  providerId: string;
  model: string;
  // true makes it the default; false on the default takes the mark off,
  // so the first created is the default again; absent leaves the mark
  default?: boolean;
};

// POST /api/deciders/:id/check: one fixed yes/no answered. probability
// is the chance of the answer given, ms the whole call, cost in USD
// when the server named one, served the model build that answered.
// A refusal or a timeout is a 502 with the wire's words
export type CheckDeciderResponse = {
  pick: boolean;
  probability: number;
  ms: number;
  cost: number | null;
  served: string;
};
