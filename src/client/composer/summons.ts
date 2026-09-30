// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The @ menu's logic without a DOM, as the slash menu's: which agents
// a draft is naming, what a pick fills, and why Enter refuses a first
// word that names no agent, in the server's words so the composer
// never sends a turn the server would refuse. A new chat starts on
// the picked agent and cannot summon, so its composer opens no menu.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import {
  noAgentNamed,
  readSummon,
  summonName,
  summonWord,
} from "../../shared/summon.ts";

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

// why Enter refuses the text, or null to send it. In a chat, a first
// word naming no agent of the project, the chat's own name being an
// ordinary turn; in a new chat, any first word naming another agent
// than the picked one. An unloaded list leaves it to the server
export function summonRefusal(
  text: string,
  agents: readonly AgentSummary[] | null,
  agentId: string | null,
  started: boolean,
): string | null {
  if (agents === null || agentId === null) return null;
  const own = agents.find((agent) => agent.id === agentId)?.name;
  if (own === undefined) return null;
  if (!started) {
    const name = summonName(text);
    return name !== null && name !== own
      ? noAgentNamed(summonWord(text)!)
      : null;
  }
  const read = readSummon(text, own, (name) =>
    agents.some((agent) => agent.name === name),
  );
  return read.kind === "unknown" ? noAgentNamed(read.word) : null;
}
