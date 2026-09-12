// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the agent and provider forms check before they call, the same
// rules the server applies, the presets a provider is made from, and
// the words a row shows for a window, a price and a key.

import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import {
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

// "128k", "1M"; empty when the catalog did not say
export function windowLine(contextLength: number | null): string {
  if (contextLength === null) return "";
  if (contextLength >= 1_000_000) {
    return `${Math.round(contextLength / 100_000) / 10}M`;
  }
  return `${Math.round(contextLength / 1000)}k`;
}

const money = (n: number) => `$${Number(n.toPrecision(3))}`;

// "$0.14 / $0.28" per million tokens, "free" when both are zero, empty
// when the catalog did not say
export function priceLine(
  promptPrice: number | null,
  completionPrice: number | null,
): string {
  if (promptPrice === null || completionPrice === null) return "";
  if (promptPrice === 0 && completionPrice === 0) return "free";
  return `${money(promptPrice)} / ${money(completionPrice)}`;
}

// "1M · $0.15 / $0.6 · tools · reasoning": what a row says about a
// model, only the parts the catalog gave
export function modelMeta(m: CatalogMatch): string {
  return [
    windowLine(m.contextLength),
    priceLine(m.promptPrice, m.completionPrice),
    m.tools ? "tools" : "",
    m.reasoning ? "reasoning" : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
}

export function keyLine(keyName: string | null, hasKey: boolean): string {
  if (keyName === null) return "no key";
  return hasKey ? `${keyName}.key` : `${keyName}.key missing`;
}
