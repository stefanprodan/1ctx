// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a task's switches turned off, in words, named only from what its
// agent and project hold.

import {
  AUTOMATIONS,
  credentialOf,
  EMAIL,
  KNOWLEDGE,
  MEMORY,
  repoOf,
  serverOf,
  skillOf,
  VISUALIZE,
  WEB,
} from "../../../shared/capabilities.ts";

export type Named = { id: string; name: string };

// what a task's switches can name: its agent's servers and skills, its
// project's credentials and repositories
export type SwitchNames = {
  servers: Named[];
  skills: Named[];
  credentials: Named[];
  repos: Named[];
};

const KIND_WORDS: Record<string, string> = {
  [WEB]: "web access",
  [VISUALIZE]: "visuals",
  [KNOWLEDGE]: "project docs",
  [EMAIL]: "email to users",
};

// a chat's alone: they mean nothing for a run, so show names neither
const CHAT_ONLY: ReadonlySet<string> = new Set([MEMORY, AUTOMATIONS]);

// the names of what a task's runs go without, read only from what its
// agent and project hold, as the page names them; with the web off a
// credential goes with it and is not named
export function switchedOff(
  keys: readonly string[],
  names: SwitchNames,
): string[] {
  const lookups: [Named[], (key: string) => string | null, string][] = [
    [names.servers, serverOf, "MCP server"],
    [names.skills, skillOf, "skill"],
    [names.credentials, credentialOf, "credential"],
    [names.repos, repoOf, "repository"],
  ];
  const webOff = keys.includes(WEB);
  const out: string[] = [];
  let gone = 0;
  for (const key of keys) {
    if (CHAT_ONLY.has(key)) continue;
    const kind = Object.hasOwn(KIND_WORDS, key) ? KIND_WORDS[key] : undefined;
    if (kind !== undefined) {
      out.push(kind);
      continue;
    }
    if (webOff && credentialOf(key) !== null) continue;
    let named: string | null = null;
    for (const [list, idOf, word] of lookups) {
      const id = idOf(key);
      if (id === null) continue;
      const item = list.find((thing) => thing.id === id);
      if (item !== undefined) named = `${word} ${item.name}`;
      break;
    }
    if (named === null) gone++;
    else out.push(named);
  }
  if (gone === 1) out.push("an item no longer available");
  if (gone > 1) out.push(`${gone} items no longer available`);
  return out;
}
