// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { noAgentNamed, readSummon } from "../../shared/summon.ts";
import type { AgentRow } from "../agents/index.ts";
import { BadRequest } from "../lib/errors.ts";

export type SummonAgents = {
  byId(id: string): AgentRow | null;
  byName(name: string): AgentRow | null;
};

// the agent the text summons, null for an ordinary turn; a first word
// naming no live agent is a 400, since a typo would send the turn to
// the agent it meant to check
export function summonOf(
  agents: Pick<SummonAgents, "byName">,
  chatAgent: string,
  text: string,
): AgentRow | null {
  const found: { agent: AgentRow | null } = { agent: null };
  const read = readSummon(text, chatAgent, (name) => {
    found.agent = agents.byName(name);
    return found.agent !== null;
  });
  if (read.kind === "unknown") throw new BadRequest(noAgentNamed(read.word));
  return read.kind === "summon" ? found.agent : null;
}
