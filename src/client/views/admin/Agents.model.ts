// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentServer } from "../../../shared/contracts/mcp.ts";
import type {
  CatalogMatch,
  Endpoint,
} from "../../../shared/contracts/provider.ts";
import { fourBitEndpoint, isFourBitTag } from "../../../shared/quantization.ts";
import { canStopThinking, fixedThinking } from "../../../shared/thinking.ts";
import {
  EFFORTS,
  type Effort,
  isEffort,
  MAX_CONTEXT_LENGTH,
  MIN_CONTEXT_LENGTH,
  type Wire,
} from "../../../shared/words.ts";
import { priceLine } from "../../agents/meta.ts";
import {
  digits,
  K,
  thousandsText,
  thousandsValue,
} from "../../lib/thousands.ts";
import type { Option } from "../../ui/Select.model.ts";

export function agentFieldOf(message: string): string | undefined {
  // the two refusals the page can reach name their controls by label
  if (message.startsWith("skip4Bit") || message.startsWith("Skip 4-bit"))
    return "skip4Bit";
  if (
    message.startsWith("upstream") ||
    message.startsWith("The preferred provider")
  )
    return "upstream";
  if (message.startsWith("name") || message.startsWith("an agent named"))
    return "name";
  if (message.startsWith("providerId") || message === "no such provider")
    return "provider";
  if (message.startsWith("model") || message.includes(" does not list "))
    return "model";
  if (message.startsWith("prompt")) return "prompt";
  if (message.startsWith("contextLength")) return "contextLength";
  return undefined;
}

// the runner follows the catalog's reasoning flag when the agent says
// nothing
export function defaultThinking(model: CatalogMatch | null): "on" | "off" {
  return model?.reasoning ? "on" : "off";
}

type Choice<T> = { value: T; label: string };

// an undescribed model's catalog does not say whether it thinks, so its
// default names no side
export function thinkingChoices(
  model: CatalogMatch | null,
  wire?: Wire,
  saved: "on" | "off" | null = null,
): Choice<"on" | "off" | null>[] {
  const fixed = model === null ? null : fixedThinking(model);
  if (fixed !== null) {
    return [{ value: null, label: fixed === "on" ? "On" : "Off" }];
  }
  const choices: Choice<"on" | "off" | null>[] = [
    {
      value: null,
      label:
        model !== null && !model.described
          ? "Default"
          : `Default (${defaultThinking(model)})`,
    },
    { value: "on", label: "On" },
  ];
  // a saved Off stays listed so the form shows what is stored
  if (model === null || saved === "off" || canStopThinking(wire, model.id)) {
    choices.push({ value: "off", label: "Off" });
  }
  return choices;
}

// what Off does where the catalog cannot say which models always think:
// azure sends such a model's Off at the least effort
export function thinkingHint(wire: Wire | undefined): string | null {
  return wire === "azure"
    ? "A model that cannot stop thinking runs at Low."
    : null;
}

// a newly picked model drops a thinking word it cannot take
export function resetsThinking(
  model: CatalogMatch,
  wire: Wire | undefined,
  thinking: "on" | "off" | null,
): boolean {
  if (fixedThinking(model) !== null) return true;
  return thinking === "off" && !canStopThinking(wire, model.id);
}

export function effortChoices(wire: Wire): Choice<Effort | null>[] {
  return [
    { value: null, label: "Default" },
    ...EFFORTS[wire].map((level) => ({ value: level, label: level })),
  ];
}

export function effortApplies(
  model: CatalogMatch | null,
  thinking: "on" | "off" | null,
): boolean {
  if (model !== null) thinking = fixedThinking(model) ?? thinking;
  if (thinking === "off") return false;
  if (thinking === "on") return true;
  return model?.reasoning === true;
}

// an effort the choices hide is not sent: the runner would ignore it or
// the wire refuse it
export function sentEffort(
  model: CatalogMatch | null,
  thinking: "on" | "off" | null,
  effort: Effort | null,
  wire: Wire | undefined,
): Effort | null {
  if (wire === undefined || !effortApplies(model, thinking)) return null;
  return effort !== null && isEffort(wire, effort) ? effort : null;
}

export function skillsCount(chosen: number, cap: number): string {
  return `${chosen} of ${cap}`;
}

export function sameServers(a: AgentServer[], b: AgentServer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: AgentServer) =>
    `${s.serverId}:${s.read ? 1 : 0}${s.write ? 1 : 0}`;
  const bKeys = new Set(b.map(key));
  return a.every((s) => bKeys.has(key(s)));
}

// a list that did not load keeps the picks as they are
export function listed<T>(
  picks: T[],
  idOf: (pick: T) => string,
  rows: { id: string }[] | null,
): T[] {
  return rows === null
    ? picks
    : picks.filter((p) => rows.some((r) => r.id === idOf(p)));
}

// The window is typed in thousands of tokens (lib/thousands.ts)
const MIN_K = Math.ceil(MIN_CONTEXT_LENGTH / K);
const MAX_K = Math.floor(MAX_CONTEXT_LENGTH / K);

export function windowText(tokens: number | null): string {
  return tokens === null ? "" : thousandsText(tokens);
}

const unchanged = (value: string, saved: number | null) =>
  saved !== null && digits(value) === windowText(saved);

export function contextProblem(
  value: string,
  tools: boolean,
  saved: number | null = null,
): string | null {
  const v = digits(value);
  if (v === "") return tools ? "Enter the context window" : null;
  if (unchanged(value, saved)) return null;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < MIN_K || n > MAX_K) {
    return `Enter a whole number of thousands from ${MIN_K} to ${MAX_K.toLocaleString("en-US")}`;
  }
  return null;
}

function contextValue(value: string, saved: number | null): number | null {
  const v = digits(value);
  if (v === "") return null;
  return thousandsValue(value, saved === null ? [] : [saved]);
}

// the server refuses a stated window and tools for a described model
export function statedFields(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
  saved: number | null = null,
): { contextLength?: number | null; tools?: boolean } {
  if (model === null || model.described) return {};
  return { contextLength: contextValue(contextLength, saved), tools };
}

export function statedModel(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
  saved: number | null = null,
): CatalogMatch | null {
  if (model === null || model.described) return model;
  return {
    ...model,
    contextLength:
      contextProblem(contextLength, false, saved) === null
        ? contextValue(contextLength, saved)
        : null,
    tools,
  };
}

export function statedProblem(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
  saved: number | null = null,
): string | null {
  if (model === null || model.described) return null;
  return contextProblem(contextLength, tools, saved);
}

// an endpoint without tools never serves a model that takes them; a
// saved tag is flagged only when the list loaded, a failed one says nothing
export function upstreamOptions(
  endpoints: Endpoint[] | null,
  takesTools: boolean,
  saved: string | null,
  skip4Bit = false,
): Option[] {
  const shown = (endpoints ?? []).filter((e) => !takesTools || e.tools);
  const label = (e: Endpoint) =>
    e.quantization === null ? e.name : `${e.name} ${e.quantization}`;
  const twice = (e: Endpoint) =>
    shown.filter((other) => label(other) === label(e)).length > 1;
  const options: Option[] = [
    { value: "", label: "Any provider", detail: "OpenRouter picks" },
    ...shown.map((e) => ({
      value: e.tag,
      label: twice(e) ? e.tag : label(e),
      detail: [
        priceLine(e.promptPrice, e.completionPrice),
        e.discount > 0 ? `${Math.round(e.discount * 100)}% off` : "",
      ]
        .filter((part) => part !== "")
        .join(" · "),
      keywords: e.tag,
      ...(skip4Bit && fourBitEndpoint(e)
        ? { disabled: true, title: SKIPPED }
        : {}),
    })),
  ];
  if (saved !== null && !shown.some((e) => e.tag === saved)) {
    const listed = endpoints?.find((e) => e.tag === saved);
    const skipped =
      skip4Bit &&
      (listed === undefined ? isFourBitTag(saved) : fourBitEndpoint(listed))
        ? { disabled: true, title: SKIPPED }
        : {};
    options.push(
      endpoints === null
        ? { value: saved, label: saved, ...skipped }
        : {
            value: saved,
            label: saved,
            detail: listed ? "no tools" : "not listed now",
            ...skipped,
          },
    );
  }
  return options;
}

export const SKIPPED = "Skipped by Skip 4-bit providers";
export const PREFERRED_FOUR_BIT = "The preferred provider is 4-bit";
export const ALL_FOUR_BIT = "Every provider of this model is 4-bit";

// why Skip 4-bit providers cannot be turned on, or null: the filter
// leaves out the preferred host too, and a model no host passes answers
// nothing. A list that failed judges the preferred tag alone
export function skip4BitLock(
  endpoints: Endpoint[] | null,
  takesTools: boolean,
  upstream: string | null,
): string | null {
  if (upstream !== null) {
    const listed = endpoints?.find((e) => e.tag === upstream);
    const fourBit =
      listed === undefined ? isFourBitTag(upstream) : fourBitEndpoint(listed);
    if (fourBit) return PREFERRED_FOUR_BIT;
  }
  const serving = (endpoints ?? []).filter((e) => !takesTools || e.tools);
  if (serving.length > 0 && serving.every(fourBitEndpoint)) {
    return ALL_FOUR_BIT;
  }
  return null;
}
