// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a chat has turned off, as the composer shows it. The chat's own
// set rides on its session. This module holds the keys the project's
// agents route says can be switched now, and the flips a person made but
// has not sent: only the keys they touched, laid over the session's set,
// so an envelope from another member moves every key left alone. A send
// carries the flips as a change and the server applies it to the set it
// holds then. A reload forgets them, and so does leaving the chat.

import { effect, signal } from "@preact/signals";
import type { SwitchableServer } from "../../shared/api/sessions.ts";
import type { CapabilityChange } from "../../shared/capabilities.ts";
import { me } from "./me.ts";

// the keys a send starting now could turn off, null until the project's
// agents answered
export const switchable = signal<readonly string[] | null>(null);

// by agent id, the MCP servers the agent is offered now, from the same
// answer; an agent without one has no entry
export const servers = signal<Readonly<Record<string, SwitchableServer[]>>>({});

// the chat a flip belongs to, "" for one not made yet; key to off
type Flips = ReadonlyMap<string, boolean>;
const NEW = "";
const pending = signal<{ scope: string; flips: Flips }>({
  scope: NEW,
  flips: new Map(),
});

let owner: string | null = null;
effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  switchable.value = null;
  servers.value = {};
  pending.value = { scope: NEW, flips: new Map() };
});

const scopeOf = (sessionId: string | null) => sessionId ?? NEW;

function flipsOf(sessionId: string | null): Flips {
  const held = pending.value;
  return held.scope === scopeOf(sessionId) ? held.flips : new Map();
}

// whether a key is off as the composer shows it
export function isOff(
  sessionId: string | null,
  stored: readonly string[],
  key: string,
): boolean {
  return flipsOf(sessionId).get(key) ?? stored.includes(key);
}

// a flip back to what the session holds is no flip at all
export function flip(
  sessionId: string | null,
  stored: readonly string[],
  key: string,
): void {
  const off = !isOff(sessionId, stored, key);
  const flips = new Map(flipsOf(sessionId));
  if (off === stored.includes(key)) flips.delete(key);
  else flips.set(key, off);
  pending.value = { scope: scopeOf(sessionId), flips };
}

// the body's field, absent when nothing was touched
export function changeOf(
  sessionId: string | null,
): { capabilities: CapabilityChange } | Record<string, never> {
  const flips = flipsOf(sessionId);
  if (flips.size === 0) return {};
  const disable = [...flips].filter(([, off]) => off).map(([key]) => key);
  const enable = [...flips].filter(([, off]) => !off).map(([key]) => key);
  return {
    capabilities: {
      ...(disable.length === 0 ? {} : { disable: disable.sort() }),
      ...(enable.length === 0 ? {} : { enable: enable.sort() }),
    },
  };
}

// the server took the send, so its set holds what that send carried; a
// refused send keeps the flips for the next try. Only the flips the
// request carried go: one made while it was on its way was never sent,
// and stays for the next
export function accepted(
  sessionId: string | null,
  sent: { capabilities?: CapabilityChange },
): void {
  if (pending.value.scope !== scopeOf(sessionId)) return;
  const flips = new Map(pending.value.flips);
  for (const key of sent.capabilities?.disable ?? []) {
    if (flips.get(key) === true) flips.delete(key);
  }
  for (const key of sent.capabilities?.enable ?? []) {
    if (flips.get(key) === false) flips.delete(key);
  }
  pending.value = { scope: pending.value.scope, flips };
}

// another agent was picked in a chat not made yet: the flips of one kind
// named the other agent's servers
export function dropKind(sessionId: string | null, kind: string): void {
  if (pending.value.scope !== scopeOf(sessionId)) return;
  const flips = new Map(pending.value.flips);
  for (const key of flips.keys()) {
    if (key.startsWith(`${kind}:`)) flips.delete(key);
  }
  if (flips.size === pending.value.flips.size) return;
  pending.value = { scope: pending.value.scope, flips };
}

// the composer left the chat, so what was flipped there and never sent
// is given up, not kept for a later visit
export function dropFlips(sessionId: string | null): void {
  if (pending.value.scope !== scopeOf(sessionId)) return;
  pending.value = { scope: NEW, flips: new Map() };
}
