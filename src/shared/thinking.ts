// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CatalogMatch } from "./contracts/provider.ts";

// what the catalog leaves no choice about: on for a model that always
// thinks, off for one a reliable catalog says never thinks, null when
// the agent's word decides
export function fixedThinking(
  model: Pick<
    CatalogMatch,
    "reasoningKnown" | "reasoning" | "thinkingRequired"
  >,
): "on" | "off" | null {
  if (model.thinkingRequired) return "on";
  if (model.reasoningKnown && !model.reasoning) return "off";
  return null;
}
