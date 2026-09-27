// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the Deciders card: a decider's window and input price,
// the providers a decider can run on, which field a refusal names,
// and what a Check answered.

import type { CheckDeciderResponse } from "../../../shared/api/deciders.ts";
import { DECIDER_WIRES } from "../../../shared/contracts/decider.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { windowLine } from "../../agents/meta.ts";
import { commas } from "../../lib/format.ts";

export const NO_DECIDERS =
  "No deciders yet. Decisions stay off until one is added.";

// only these wires answer decisions
export const deciderProviders = (rows: ProviderSummary[]): ProviderSummary[] =>
  rows.filter((p) => (DECIDER_WIRES as readonly string[]).includes(p.wire));

// the provider the form holds: the one picked while it is still
// offered, else the first offered, else none; a provider may be
// deleted, or the first eligible one added, on the same page
export function heldProvider(
  offered: ProviderSummary[],
  picked: string,
): string {
  return offered.some((p) => p.id === picked) ? picked : (offered[0]?.id ?? "");
}

// the provider field's check before a save
export function providerProblem(
  offered: ProviderSummary[],
  picked: string,
): string | null {
  if (picked !== "") return null;
  return offered.length === 0
    ? "Add an OpenRouter or OpenAI-compatible provider first"
    : "Pick a provider";
}

// "$0.04 input" per million tokens, "free" at zero, empty when the
// catalog did not say; a decision's output costs nothing
export function inputPriceLine(promptPrice: number | null): string {
  if (promptPrice === null) return "";
  if (promptPrice === 0) return "free";
  return `$${Number(promptPrice.toPrecision(3))} input`;
}

// "32K · $0.04 input": only the parts the catalog gave
export function deciderMeta(m: {
  contextLength: number | null;
  promptPrice: number | null;
}): string {
  return [windowLine(m.contextLength), inputPriceLine(m.promptPrice)]
    .filter((s) => s !== "")
    .join(" · ");
}

// "$0.000001": two significant digits, never an exponent
export function checkCost(cost: number): string {
  if (cost <= 0) return "$0";
  const digits = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(cost))));
  const fixed = cost.toFixed(digits).replace(/\.?0+$/, "");
  return `$${fixed}`;
}

// what a Check answered: how long it took, and what it cost when the
// server named a cost
export function checkLine(answer: CheckDeciderResponse): string {
  const took = `Answered in ${commas(Math.round(answer.ms))} ms`;
  return answer.cost === null ? took : `${took} for ${checkCost(answer.cost)}`;
}

// which field of the decider form a save's refusal names, matched on
// the server's whole phrases so a provider's own name never steers it;
// a Check never comes here, its refusal is always the foot's
const DECIDER_FIELDS: [RegExp, string][] = [
  [/^name must be /, "name"],
  [/^a decider named .+ exists$/, "name"],
  [/^providerId must be /, "provider"],
  [/^no such provider$/, "provider"],
  [/ serves no decision models$/, "provider"],
  [/^model must be /, "model"],
  [/ does not list .+ as a decision model$/, "model"],
];

export function deciderFieldOf(message: string): string | undefined {
  return DECIDER_FIELDS.find(([words]) => words.test(message))?.[1];
}
