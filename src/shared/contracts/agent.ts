// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent as the wire exposes it: a name, the provider it runs on and
// the model, with what the catalog said about that model when it was
// picked, so a list shows the window and the prices without asking.

import type { CatalogMatch } from "./provider.ts";

export type AgentSummary = {
  id: string;
  name: string;
  providerId: string;
  model: CatalogMatch;
  createdAt: number;
};
