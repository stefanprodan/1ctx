// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the agent and provider forms check before they call, the same
// rules the server applies, the presets a provider is made from, and
// the words a row shows for a window, a price and a key.

import { compactsAt } from "../../../shared/compaction.ts";
import { windowLine } from "../../agents/meta.ts";

export {
  modelMeta,
  priceLine,
  thinkingLine,
  windowLine,
} from "../../agents/meta.ts";

import type { LimitRow } from "../../../shared/contracts/limit.ts";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import {
  EFFORTS,
  type Effort,
  isEffort,
  isName,
  MAX_NAME,
  MIN_NAME,
  type Wire,
} from "../../../shared/words.ts";

// what New provider offers: OpenRouter, whose address is known, or any
// server speaking the plain OpenAI chat shape, whose address is typed
export type Preset = {
  wire: Wire;
  label: string;
  text: string;
  // the fixed base URL, or null when the admin types it
  baseUrl: string | null;
  // the name and key file suggested when the fields are empty
  name: string;
};
export const PRESETS: Preset[] = [
  {
    wire: "openrouter",
    label: "OpenRouter",
    text: "Every model on openrouter.ai, priced from its catalog.",
    baseUrl: "https://openrouter.ai/api/v1",
    name: "openrouter",
  },
  {
    wire: "openai-compatible",
    label: "OpenAI-compatible server",
    text: "mlx-serve, llama-server, vLLM, Ollama: any /chat/completions.",
    baseUrl: null,
    name: "",
  },
];
export const preset = (wire: Wire): Preset =>
  PRESETS.find((p) => p.wire === wire) ?? PRESETS[0];

export function nameProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return "Enter a name";
  if (!isName(v)) {
    return `A name is ${MIN_NAME} to ${MAX_NAME} lowercase letters, digits and dashes`;
  }
  return null;
}

export function baseUrlProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return "Enter the base URL";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "The base URL does not parse";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "The base URL must be http or https";
  }
  return null;
}

// the key file's name, or empty for a server with no key
export function keyNameProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (!/^[a-z][a-z0-9-]*$/.test(v) || v.length > 64) {
    return "A key name is lowercase letters, digits and dashes";
  }
  return null;
}

// the reserve the runner keeps, from the limits the tools page holds;
// null until they are loaded
export function reserveOf(rows: LimitRow[] | null): number | null {
  return rows?.find((row) => row.name === "contextReserve")?.value ?? null;
}

// where the runner compacts a chat on this model, by the formula it
// uses: "auto compaction at 236k", or that a model with no window is
// never compacted on its own
export function compactLine(
  contextLength: number | null,
  reserve: number | null,
): string {
  if (reserve === null) return "";
  const at = compactsAt(contextLength, reserve);
  if (at === null) return "no auto compaction";
  return `auto compaction at ${windowLine(at)}`;
}

// what the provider's default resolves to for this model: the runner
// follows the catalog's reasoning flag when the agent says nothing
export function defaultThinking(model: CatalogMatch | null): "on" | "off" {
  return model?.reasoning ? "on" : "off";
}

export type Choice<T> = { value: T; label: string };

export function thinkingChoices(
  model: CatalogMatch | null,
): Choice<"on" | "off" | null>[] {
  return [
    { value: null, label: `Default (${defaultThinking(model)})` },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
}

// the levels are the wire's: OpenRouter knows more words than a plain
// server does
export function effortChoices(wire: Wire): Choice<Effort | null>[] {
  return [
    { value: null, label: "Default" },
    ...EFFORTS[wire].map((level) => ({ value: level, label: level })),
  ];
}

// effort has no meaning without thinking, and no choice without a
// model that reasons
export function effortApplies(
  model: CatalogMatch | null,
  thinking: "on" | "off" | null,
): boolean {
  if (thinking === "off") return false;
  if (thinking === "on") return true;
  return model?.reasoning === true;
}

// what the form sends: an effort hidden by the choices is not sent, so
// the row keeps no word the runner would ignore and no level the
// provider's wire would refuse
export function sentEffort(
  model: CatalogMatch | null,
  thinking: "on" | "off" | null,
  effort: Effort | null,
  wire: Wire | undefined,
): Effort | null {
  if (wire === undefined || !effortApplies(model, thinking)) return null;
  return effort !== null && isEffort(wire, effort) ? effort : null;
}

export function keyLine(keyName: string | null, hasKey: boolean): string {
  if (keyName === null) return "no key";
  return hasKey ? `${keyName}.key` : `${keyName}.key missing`;
}
