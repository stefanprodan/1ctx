// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on an agent and its model: the window, the prices and the
// model's short name.

import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Wire } from "../../shared/words.ts";

// "128K", "1M"; empty when the catalog did not say
export function windowLine(contextLength: number | null): string {
  if (contextLength === null) return "";
  if (contextLength >= 1_000_000) {
    return `${Math.round(contextLength / 100_000) / 10}M`;
  }
  return `${Math.round(contextLength / 1000)}K`;
}

const money = (n: number) => `$${Number(n.toPrecision(3))}`;

// "$0.14 / $0.28" per million tokens, "free" when both are zero,
// "subscription" on OpenCode Go, a flat plan, empty when the catalog did
// not say
export function priceLine(
  promptPrice: number | null,
  completionPrice: number | null,
  wire: Wire | null = null,
): string {
  if (wire === "opencode") return "subscription";
  if (promptPrice === null || completionPrice === null) return "";
  if (promptPrice === 0 && completionPrice === 0) return "free";
  return `${money(promptPrice)} / ${money(completionPrice)}`;
}

// "1M · $0.15 / $0.6 · tools · reasoning": what a row says about a
// model, only the parts the catalog gave
export function modelMeta(m: CatalogMatch, wire: Wire | null = null): string {
  return [
    windowLine(m.contextLength),
    priceLine(m.promptPrice, m.completionPrice, wire),
    m.tools ? "tools" : "",
    m.reasoning ? "reasoning" : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

// the model's own name, the org before the slash gone: what a narrow
// line shows when "org/name" does not fit
export function shortModel(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
