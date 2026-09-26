// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the agent and provider forms check before they call (an empty
// name and the base URL; the name rule is the server's),
// the presets a provider is made from, and the words a row shows for a
// window, a price and a key.

import type { AgentImpactResponse } from "../../../shared/api/agents.ts";
import { compactsAt } from "../../../shared/compaction.ts";
import type { LimitRow } from "../../../shared/contracts/limit.ts";
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
import { priceLine, windowLine } from "../../agents/meta.ts";
import { commas, pluralCommas } from "../../lib/format.ts";
import type { Option } from "../../ui/Select.model.ts";

// what New provider offers: a server speaking the OpenAI chat shape with
// the local servers' extra fields, or one that refuses anything outside
// the spec, whose addresses are typed, then OpenRouter, whose address
// is filled in and may move to its EU one, and Google AI Studio
type Preset = {
  wire: Wire;
  label: string;
  text: string;
  // the base URL filled in, or null when the admin types it
  baseUrl: string | null;
  // the address cannot be changed
  fixed: boolean;
  // said under the address field
  hint: string | null;
  // the name suggested when the field is empty
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

// the address a preset change leaves in the field: what the admin typed
// stays, a preset's own address (OpenRouter's EU one too) is replaced
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

// which field of the agent form a refusal names; a chat or an automation
// running on the agent is the form's
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

// which field of the provider form a refusal names; a catalog that does
// not answer is the form's
export function providerFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("a provider named"))
    return "name";
  if (message.startsWith("baseUrl")) return "baseUrl";
  if (message.startsWith("keyName")) return "keyName";
  return undefined;
}

// the reserve the runner keeps, from the limits the tools page holds;
// null until they are loaded
export function reserveOf(rows: LimitRow[] | null): number | null {
  return rows?.find((row) => row.name === "contextReserve")?.value ?? null;
}

// where the runner compacts a chat on this model, by the formula it
// uses: "auto compaction at 236K", or that a model with no window is
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

// a catalog that does not describe the model does not say whether it
// thinks, so its default names no side
export function thinkingChoices(
  model: CatalogMatch | null,
): Choice<"on" | "off" | null>[] {
  // a model that always or never thinks has no choice to make
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
  if (model !== null) thinking = fixedThinking(model) ?? thinking;
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

// beside the skills label: how many are checked against the cap
export function skillsCount(chosen: number, cap: number): string {
  return `${chosen} of ${cap}`;
}

// the same servers with the same sides, in any order
export function sameServers(a: AgentServer[], b: AgentServer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: AgentServer) =>
    `${s.serverId}:${s.read ? 1 : 0}${s.write ? 1 : 0}`;
  const bKeys = new Set(b.map(key));
  return a.every((s) => bKeys.has(key(s)));
}

// a side toggled on an agent's server: a link gains or loses the side,
// and one with neither side goes
export function toggleSide(
  current: AgentServer[],
  serverId: string,
  side: "read" | "write",
): AgentServer[] {
  const link = current.find((s) => s.serverId === serverId);
  const next = link
    ? { ...link, [side]: !link[side] }
    : { serverId, read: side === "read", write: side === "write" };
  return [
    ...current.filter((s) => s.serverId !== serverId),
    ...(next.read || next.write ? [next] : []),
  ];
}

// a server or a skill deleted since the agent was saved is not a line,
// and it goes from the save too, since the server would refuse the id;
// when the list did not load, the picks are kept as they are
export function listed<T>(
  picks: T[],
  idOf: (pick: T) => string,
  rows: { id: string }[] | null,
): T[] {
  return rows === null
    ? picks
    : picks.filter((p) => rows.some((r) => r.id === idOf(p)));
}

// the window an admin types for a model its catalog does not describe:
// the problem, or null. Empty is no window, allowed without tools
export function contextProblem(value: string, tools: boolean): string | null {
  const v = value.trim().replaceAll(/[,_ ]/g, "");
  if (v === "") return tools ? "Enter the context window" : null;
  const n = Number(v);
  if (
    !Number.isInteger(n) ||
    n < MIN_CONTEXT_LENGTH ||
    n > MAX_CONTEXT_LENGTH
  ) {
    return `Enter a whole number from ${MIN_CONTEXT_LENGTH} to ${MAX_CONTEXT_LENGTH}`;
  }
  return null;
}

// the typed window as the body carries it, null when empty
function contextValue(value: string): number | null {
  const v = value.trim().replaceAll(/[,_ ]/g, "");
  return v === "" ? null : Number(v);
}

// what the save sends for the model: the stated window and tools flag
// only for a model the catalog does not describe, since the server
// refuses them for one it does
export function statedFields(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
): { contextLength?: number | null; tools?: boolean } {
  if (model === null || model.described) return {};
  return { contextLength: contextValue(contextLength), tools };
}

// the pick as a send would see it: for a model the catalog does not
// describe, the typed window when it is a valid one and the tools flag
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

// the window's problem for a model the catalog does not describe, and
// none for one it does, since then the form asks nothing
export function statedProblem(
  model: CatalogMatch | null,
  contextLength: string,
  tools: boolean,
): string | null {
  if (model === null || model.described) return null;
  return contextProblem(contextLength, tools);
}

// the Preferred provider choices: any provider first, then the endpoints as the
// server sorted them, "InferenceNet fp4" over "$0.05 / $0.14 · 50% off".
// One without tools never serves a turn of a model that takes them, so
// it is left out. A saved tag stays a choice, said to be gone or without
// tools only when the list loaded, since a list that failed says nothing
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

// The line over an agent's Delete ask: the chats it archives and the
// automations it pauses, then what it stops, each part only when there
// is any; empty when the delete touches nothing.
export function impactLine(impact: AgentImpactResponse): string {
  const { chats, automations, running } = impact;
  const chatWords = `${pluralCommas(chats, "chat", "chats")} will be archived`;
  const first =
    chats > 0 && automations > 0
      ? `${chatWords} and ${pluralCommas(automations, "automation", "automations")} paused.`
      : chats > 0
        ? `${chatWords}.`
        : automations > 0
          ? `${pluralCommas(automations, "automation", "automations")} will be paused.`
          : "";
  const stops =
    running > 0 ? `${commas(running)} running now will be stopped.` : "";
  return [first, stops].filter((part) => part !== "").join(" ");
}
