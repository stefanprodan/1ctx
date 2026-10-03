// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Wire } from "../../../shared/words.ts";
import { pluralCommas } from "../../lib/format.ts";

type Preset = {
  wire: Wire;
  label: string;
  text: string;
  // null: the admin types it
  baseUrl: string | null;
  // the address cannot be changed
  fixed: boolean;
  hint: string | null;
  name: string;
};
const OPENROUTER_EU = "https://eu.openrouter.ai/api/v1";

export const PRESETS: Preset[] = [
  {
    wire: "openai-compatible",
    label: "OpenAI-compatible",
    text: "mlx-serve, oMLX, llama-server, Ollama",
    baseUrl: null,
    fixed: false,
    hint: null,
    name: "",
  },
  {
    wire: "openai-strict",
    label: "OpenAI-strict",
    text: "GPT, Nvidia NIM, vLLM, Groq",
    baseUrl: null,
    fixed: false,
    hint: null,
    name: "",
  },
  {
    wire: "openrouter",
    label: "OpenRouter",
    text: "Every model on openrouter.ai, priced from its catalog.",
    baseUrl: "https://openrouter.ai/api/v1",
    fixed: false,
    hint: `${OPENROUTER_EU} keeps requests in the EU. It needs an OpenRouter Business account.`,
    name: "openrouter",
  },
  {
    wire: "gemini",
    label: "Google AI Studio",
    text: "Gemini, with the key from aistudio.google.com.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    fixed: true,
    hint: null,
    name: "gemini",
  },
  {
    wire: "opencode",
    label: "OpenCode Go",
    text: "DeepSeek, GLM, Kimi and more on an OpenCode Go plan.",
    baseUrl: "https://opencode.ai/zen/go/v1",
    fixed: false,
    hint: null,
    name: "opencode",
  },
];
export const preset = (wire: Wire): Preset =>
  PRESETS.find((p) => p.wire === wire) ?? PRESETS[0];

// a preset change keeps a typed address and replaces a preset's own
export function presetBaseUrl(current: string, next: Wire): string {
  const known = [...PRESETS.map((p) => p.baseUrl), OPENROUTER_EU];
  const typed = current.trim() !== "" && !known.includes(current.trim());
  return typed ? current : (preset(next).baseUrl ?? "");
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

export function providerFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("a provider named"))
    return "name";
  if (message.startsWith("baseUrl")) return "baseUrl";
  if (message.startsWith("keyName")) return "keyName";
  return undefined;
}

export function keyLine(keyName: string | null, hasKey: boolean): string {
  if (keyName === null) return "no key";
  return hasKey ? `${keyName}.key` : `${keyName}.key missing`;
}

export function providerDeleteLine(agentCount: number, deciderCount: number) {
  if (agentCount === 0 && deciderCount === 0) return "Nothing runs on it.";
  const parts = [
    agentCount > 0 ? pluralCommas(agentCount, "agent", "agents") : "",
    deciderCount > 0 ? pluralCommas(deciderCount, "decider", "deciders") : "",
  ].filter((part) => part !== "");
  const one = agentCount + deciderCount === 1;
  return `${parts.join(" and ")} ${one ? "runs" : "run"} on it. Move ${
    one ? "it" : "them"
  } to another provider first.`;
}
