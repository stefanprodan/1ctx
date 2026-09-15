// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the agent and provider forms check before they call (an empty
// name, the base URL and the key file; the name rule is the server's),
// the presets a provider is made from, and the words a row shows for a
// window, a price and a key.

import { compactsAt } from "../../../shared/compaction.ts";
import type { AgentServer } from "../../../shared/contracts/mcp.ts";
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

// the field shapes the name as it is typed and the server holds the
// rule, so the one slip worth catching here is an empty field
export function nameProblem(value: string): string | null {
  return value.trim() === "" ? "Enter a name" : null;
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
// which field of the agent form a refusal names; a chat or an automation
// running on the agent is the form's
export function agentFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("an agent named"))
    return "name";
  if (message.startsWith("providerId") || message === "no such provider")
    return "provider";
  if (message.startsWith("model") || message.includes(" does not list "))
    return "model";
  if (message.startsWith("prompt")) return "prompt";
  return undefined;
}

// which field of the provider form a refusal names; a catalog that does
// not answer is the form's
export function providerFieldOf(message: string): string | undefined {
  if (message.startsWith("name") || message.startsWith("a provider named"))
    return "name";
  if (message.startsWith("baseUrl")) return "baseUrl";
  if (message.includes(".key is not")) return "keyName";
  return undefined;
}

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

// beside the skills label: how many are checked against the cap
export function skillsCount(chosen: number, cap: number): string {
  return `${chosen} of ${cap}`;
}

// the same ids in any order
export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
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

// a server deleted since the agent was saved is not a line, and it
// goes from the save too, since the server would refuse the id; when
// the list did not load, the links are kept as they are
export function listedServers(
  links: AgentServer[],
  rows: { id: string }[] | null,
): AgentServer[] {
  return rows === null
    ? links
    : links.filter((s) => rows.some((r) => r.id === s.serverId));
}
