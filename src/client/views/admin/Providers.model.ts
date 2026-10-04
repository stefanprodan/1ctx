// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Wire } from "../../../shared/words.ts";
import { pluralCommas } from "../../lib/format.ts";
import { NO_KEY } from "../../lib/secrets.ts";

type Preset = {
  wire: Wire;
  label: string;
  text: string;
  // null: the admin types it
  baseUrl: string | null;
  // the address cannot be changed
  fixed: boolean;
  hint: string | null;
  // what the empty base URL field shows
  placeholder: string;
  name: string;
};
const PLACEHOLDER = "http://host:port/v1";
const OPENROUTER_EU = "https://eu.openrouter.ai/api/v1";

export const PRESETS: Preset[] = [
  {
    wire: "openai-compatible",
    label: "OpenAI-compatible",
    text: "mlx-serve, oMLX, llama-server, Ollama",
    baseUrl: null,
    fixed: false,
    hint: null,
    placeholder: PLACEHOLDER,
    name: "",
  },
  {
    wire: "openai-strict",
    label: "OpenAI-strict",
    text: "GPT, Nvidia NIM, vLLM, Groq",
    baseUrl: null,
    fixed: false,
    hint: null,
    placeholder: PLACEHOLDER,
    name: "",
  },
  {
    wire: "openrouter",
    label: "OpenRouter",
    text: "Every model on openrouter.ai, priced from its catalog.",
    baseUrl: "https://openrouter.ai/api/v1",
    fixed: false,
    hint: `${OPENROUTER_EU} keeps requests in the EU. It needs an OpenRouter Business account.`,
    placeholder: PLACEHOLDER,
    name: "openrouter",
  },
  {
    wire: "gemini",
    label: "Google AI Studio",
    text: "Gemini, with the key from aistudio.google.com.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    fixed: true,
    hint: null,
    placeholder: PLACEHOLDER,
    name: "gemini",
  },
  {
    wire: "opencode",
    label: "OpenCode Go",
    text: "DeepSeek, GLM, Kimi and more on an OpenCode Go plan.",
    baseUrl: "https://opencode.ai/zen/go/v1",
    fixed: false,
    hint: null,
    placeholder: PLACEHOLDER,
    name: "opencode",
  },
  {
    wire: "azure",
    label: "Microsoft Foundry",
    text: "GPT models deployed on Microsoft Foundry or Azure OpenAI.",
    // each resource has its own address
    baseUrl: null,
    fixed: false,
    hint: "From the resource's Keys and Endpoint page.",
    placeholder: "https://<resource>.services.ai.azure.com/openai/v1",
    name: "azure",
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

// a server refusal in the page's words: the field it opens with by the
// field's label, never its name in the API
export function providerRefusal(message: string): string {
  return message
    .replace(/^baseUrl\b/, "The base URL")
    .replace(/^keyName\b(.*?)(?:,? or null)?$/s, "The key file$1");
}

export function providerFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("a provider named"))
    return "name";
  if (message.startsWith("baseUrl") || message.startsWith("The base URL"))
    return "baseUrl";
  if (message.startsWith("keyName") || message.startsWith("The key file"))
    return "keyName";
  return undefined;
}

// the key file a name points at, provider-<name>, when there is one
export function matchingKey(keys: readonly string[], name: string): string {
  const key = `provider-${name.trim()}`;
  return name.trim() !== "" && keys.includes(key) ? key : NO_KEY;
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
