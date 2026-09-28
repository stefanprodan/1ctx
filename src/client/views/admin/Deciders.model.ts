// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CheckDeciderResponse } from "../../../shared/api/deciders.ts";
import { DECIDER_WIRES } from "../../../shared/contracts/decider.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { windowLine } from "../../agents/meta.ts";
import { commas } from "../../lib/format.ts";

export const NO_DECIDERS =
  "No deciders yet. Decisions stay off until one is added.";

export const deciderProviders = (rows: ProviderSummary[]): ProviderSummary[] =>
  rows.filter((p) => (DECIDER_WIRES as readonly string[]).includes(p.wire));

// a provider may be deleted, or the first one added, on the same page
export function heldProvider(
  offered: ProviderSummary[],
  picked: string,
): string {
  return offered.some((p) => p.id === picked) ? picked : (offered[0]?.id ?? "");
}

// a decision's output costs nothing, so the input price is the price
export function inputPriceLine(promptPrice: number | null): string {
  if (promptPrice === null) return "";
  if (promptPrice === 0) return "free";
  return `$${Number(promptPrice.toPrecision(3))} input`;
}

export function deciderMeta(m: {
  contextLength: number | null;
  promptPrice: number | null;
}): string {
  return [windowLine(m.contextLength), inputPriceLine(m.promptPrice)]
    .filter((s) => s !== "")
    .join(" · ");
}

export function checkCost(cost: number): string {
  if (cost <= 0) return "$0";
  const digits = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(cost))));
  const fixed = cost.toFixed(digits).replace(/\.?0+$/, "");
  return `$${fixed}`;
}

export function checkLine(answer: CheckDeciderResponse): string {
  const took = `Answered in ${commas(Math.round(answer.ms))} ms`;
  return answer.cost === null ? took : `${took} for ${checkCost(answer.cost)}`;
}

// the server's whole phrases, so a provider's name never steers the field
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

export function askedBy<T extends { deciderId: string | null }>(
  decider: { id: string; default: boolean },
  decisions: T[],
): T[] {
  return decisions.filter(
    (d) =>
      d.deciderId === decider.id || (d.deciderId === null && decider.default),
  );
}

export function deciderDeleteLine(
  decider: { id: string; default: boolean },
  all: { id: string }[],
  asking: number,
): string | undefined {
  if (asking === 0) return undefined;
  const others = all.filter((d) => d.id !== decider.id).length;
  return others === 0
    ? "Decisions stay off until another decider is added."
    : "Its decisions go to the default decider.";
}
