// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentServer } from "../../../shared/contracts/mcp.ts";
import type {
  CatalogMatch,
  Endpoint,
} from "../../../shared/contracts/provider.ts";
import { fixedThinking } from "../../../shared/thinking.ts";
import {
  EFFORTS,
  type Effort,
  isEffort,
  MAX_CONTEXT_LENGTH,
  MIN_CONTEXT_LENGTH,
  type Wire,
} from "../../../shared/words.ts";
import { priceLine } from "../../agents/meta.ts";
import type { Option } from "../../ui/Select.model.ts";

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

export function agentFieldOf(message: string): string | undefined {
  if (message.startsWith("upstream")) return "upstream";
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

export function providerFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("a provider named"))
    return "name";
  if (message.startsWith("baseUrl")) return "baseUrl";
  if (message.startsWith("keyName")) return "keyName";
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
): Choice<"on" | "off" | null>[] {
  const fixed = model === null ? null : fixedThinking(model);
  if (fixed !== null) {
    return [{ value: null, label: fixed === "on" ? "On" : "Off" }];
  }
  return [
    {
      value: null,
      label:
        model !== null && !model.described
          ? "Default"
          : `Default (${defaultThinking(model)})`,
    },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
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

export function keyLine(keyName: string | null, hasKey: boolean): string {
  if (keyName === null) return "no key";
  return hasKey ? `${keyName}.key` : `${keyName}.key missing`;
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

export function contextProblem(value: string, tools: boolean): string | null {
  const v = value.trim().replaceAll(/[,_ ]/g, "");
  if (v === "") return tools ? "Enter the context window" : null;
  const n = Number(v);
  if (
    !Number.isInteger(n) ||
    n < MIN_CONTEXT_LENGTH ||
    n > MAX_CONTEXT_LENGTH
  ) {
    return `Enter a whole number from ${MIN_CONTEXT_LENGTH.toLocaleString("en-US")} to ${MAX_CONTEXT_LENGTH.toLocaleString("en-US")}`;
  }
  return null;
}

function contextValue(value: string): number | null {
  const v = value.trim().replaceAll(/[,_ ]/g, "");
  return v === "" ? null : Number(v);
}

// the server refuses a stated window and tools for a described model
export function statedFields(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
): { contextLength?: number | null; tools?: boolean } {
  if (model === null || model.described) return {};
  return { contextLength: contextValue(contextLength), tools };
}

export function statedModel(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
): CatalogMatch | null {
  if (model === null || model.described) return model;
  return {
    ...model,
    contextLength:
      contextProblem(contextLength, false) === null
        ? contextValue(contextLength)
        : null,
    tools,
  };
}

export function statedProblem(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
): string | null {
  if (model === null || model.described) return null;
  return contextProblem(contextLength, tools);
}

// an endpoint without tools never serves a model that takes them; a
// saved tag is flagged only when the list loaded, a failed one says nothing
export function upstreamOptions(
  endpoints: Endpoint[] | null,
  takesTools: boolean,
  saved: string | null,
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
    })),
  ];
  if (saved !== null && !shown.some((e) => e.tag === saved)) {
    const listed = endpoints?.some((e) => e.tag === saved);
    options.push(
      endpoints === null
        ? { value: saved, label: saved }
        : {
            value: saved,
            label: saved,
            detail: listed ? "no tools" : "not listed now",
          },
    );
  }
  return options;
}
