// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The @ menu's logic without a DOM, as the slash menu's: which agents
// a draft is naming and what a pick fills. Whether a first word names
// an agent is the server's to say, since the list here is loaded once
// a visit and an agent made since would be refused. A new chat starts
// on the picked agent and cannot summon, so its composer opens no menu.

import type { AgentSummary } from "../../shared/contracts/agent.ts";

// what the menu filters on: the word after the @, lowercase since
// names are; null when the draft is not a lone @ word
export function summonQuery(draft: string): string | null {
  if (!draft.startsWith("@")) return null;
  if (/\s/.test(draft)) return null;
  return draft.slice(1).toLowerCase();
}

// the project's agents the draft starts, the chat's own left out; a
// new chat (no agent yet) lists none. The list holds live agents only
export function summonMatches(
  draft: string,
  agents: readonly AgentSummary[] | null,
  chatAgentId: string | null,
): AgentSummary[] {
  const query = summonQuery(draft);
  if (query === null || agents === null || chatAgentId === null) return [];
  return agents.filter(
    (agent) => agent.id !== chatAgentId && agent.name.startsWith(query),
  );
}

// what the box fills on Tab or a click: the name and a space for the ask
export const summonFill = (agent: AgentSummary): string => `@${agent.name} `;
