// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a chat or an automation turned off for itself. The set stores
// what is off, since on is the default: a thing added to an agent later
// is on everywhere without a write, and the empty set is every chat that
// never touched a switch. A key is a kind, or a kind and a name after a
// colon. Web access is a kind alone, and so is the visualize tool. An
// MCP server is `mcp:<server id>`: the id, since the name is not what an
// agent's links hold. A skill is `skill:<skill id>`, by the same rule. An
// HTTP credential is `credential:<credential id>`.

export const WEB = "web";
export const VISUALIZE = "visualize";
export const MCP = "mcp";
export const SKILL = "skill";
export const CREDENTIAL = "credential";

// a row id, as lib/ids.ts makes them
const ID = /^[0-9a-z]{1,32}$/;

export const mcpKey = (serverId: string) => `${MCP}:${serverId}`;
export const skillKey = (skillId: string) => `${SKILL}:${skillId}`;
export const credentialKey = (credentialId: string) =>
  `${CREDENTIAL}:${credentialId}`;

function idOf(kind: string, key: string): string | null {
  if (!key.startsWith(`${kind}:`)) return null;
  const id = key.slice(kind.length + 1);
  return ID.test(id) ? id : null;
}

// the server a key names, null for any other key
export const serverOf = (key: string) => idOf(MCP, key);

// the skill a key names, null for any other key
export const skillOf = (key: string) => idOf(SKILL, key);

// the credential a key names, null for any other key
export const credentialOf = (key: string) => idOf(CREDENTIAL, key);

export const MAX_CAPABILITY_KEY = 64;
export const MAX_DISABLED_CAPABILITIES = 64;

export function isCapabilityKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CAPABILITY_KEY &&
    // the shape alone: a key naming no server or skill, or one the agent
    // does not have, is kept and ignored, so a fork onto another agent
    // still sends
    (value === WEB ||
      value === VISUALIZE ||
      serverOf(value) !== null ||
      skillOf(value) !== null ||
      credentialOf(value) !== null)
  );
}

// what a send carries: only the keys the person touched, applied by the
// server to the set the chat holds then, so an untouched composer never
// undoes what another member flipped
export type CapabilityChange = { disable?: string[]; enable?: string[] };

export type SetResult =
  | { ok: true; set: string[] }
  | { ok: false; error: string };
export type ChangeResult =
  | { ok: true; change: CapabilityChange }
  | { ok: false; error: string };

const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();

function keysOf(value: unknown, field: string): SetResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} must be a list` };
  }
  if (value.length > MAX_DISABLED_CAPABILITIES) {
    return {
      ok: false,
      error: `${field} holds at most ${MAX_DISABLED_CAPABILITIES} keys`,
    };
  }
  for (const key of value) {
    if (!isCapabilityKey(key)) {
      return { ok: false, error: `${field} names an unknown capability` };
    }
  }
  return { ok: true, set: sorted(value as string[]) };
}

// a whole set, as an automation's editor saves it and a row stores it
export function parseSet(value: unknown, field: string): SetResult {
  return keysOf(value, field);
}

// the change of a create, send or regenerate body
export function parseChange(value: unknown, field: string): ChangeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${field} must be an object` };
  }
  const change: CapabilityChange = {};
  for (const [name, keys] of Object.entries(value)) {
    if (name !== "disable" && name !== "enable") {
      return { ok: false, error: `${field}.${name} is not expected` };
    }
    const parsed = keysOf(keys, `${field}.${name}`);
    if (!parsed.ok) return parsed;
    change[name] = parsed.set;
  }
  const off = new Set(change.disable ?? []);
  if ((change.enable ?? []).some((key) => off.has(key))) {
    return { ok: false, error: `${field} disables and enables one key` };
  }
  return { ok: true, change };
}

export function applyChange(
  set: readonly string[],
  change: CapabilityChange | undefined,
): SetResult {
  const next = new Set(set);
  for (const key of change?.disable ?? []) next.add(key);
  for (const key of change?.enable ?? []) next.delete(key);
  if (next.size > MAX_DISABLED_CAPABILITIES) {
    return {
      ok: false,
      error: `at most ${MAX_DISABLED_CAPABILITIES} capabilities can be off`,
    };
  }
  return { ok: true, set: sorted(next) };
}

export const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

// the last line of the system prompt but for a change note, while a chat
// has web access off: constant, so every send after the flip shares it
export const WEB_OFF_LINE =
  "The user turned web access off for this chat. Do not call webfetch or websearch or use curl. Say so if the web is needed.";

// the line after it while a chat has the visualize tool off: a visual
// drawn before the flip is in the history, and the model would call the
// tool again and get an unknown tool
export const VISUALIZE_OFF_LINE =
  "The user turned the visualize tool off for this chat. Do not call visualize.";

// the line after it while a chat has servers off that its agent would
// otherwise be offered: names sorted, so it is constant between flips
export function mcpOffLine(names: readonly string[]): string {
  return `The user turned these MCP servers off for this chat: ${[...names].sort().join(", ")}. Their tools are not available. Say so if one is needed.`;
}

// the line after that while a chat has skills of its agent off: one
// loaded before the flip left its body in the history
export function skillsOffLine(names: readonly string[]): string {
  return `The user turned these skills off for this chat: ${[...names].sort().join(", ")}. Do not load or follow them.`;
}
