// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CatalogMatch } from "./contracts/provider.ts";
import type { Wire } from "./words.ts";

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

// Gemini's Pro models always think: the wire turns an off into the least
// thinking, so no Off is offered
export function canStopThinking(
  wire: Wire | null | undefined,
  model: string,
): boolean {
  return wire !== "gemini" || !model.toLowerCase().includes("pro");
}
