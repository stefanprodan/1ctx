// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat message whose first word is @name gets one turn from that
// agent. The chat's agent does not change; the summoned send carries
// its agent and the summoned flag, and a regenerate reruns on them, never
// on the text. Chats only: a new chat starts on the picked agent and a
// run never summons.

import { compactsAt } from "../../shared/compaction.ts";
import {
  noAgentNamed,
  readSummon,
  summonName,
  summonWord,
} from "../../shared/summon.ts";
import type { Wire } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { BadRequest } from "../lib/errors.ts";
import { lastPrompt, type SessionStore } from "../sessions/index.ts";
import { type LookupDeps, roundLookups } from "./lookups.ts";
import { lastSummary, tailBudget, tailOf } from "./tail.ts";

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

// a turn's summoned agent: one message at most, and alone
export function turnSummon(
  agents: Pick<SummonAgents, "byName">,
  chatAgent: string,
  texts: readonly string[],
): AgentRow | null {
  const found = texts.map((text) => summonOf(agents, chatAgent, text));
  const summoned = found.find((agent) => agent !== null) ?? null;
  if (summoned !== null && texts.length > 1) {
    throw new BadRequest("a summon starts its own turn");
  }
  return summoned;
}

// a new chat's first message starts on the picked agent
const NEW_CHAT_PICKS = "a new chat starts on the picked agent";

export function refuseNewSummon(
  agents: Pick<SummonAgents, "byName">,
  pickedAgent: string,
  text: string,
): void {
  const name = summonName(text);
  if (name === null || name === pickedAgent) return;
  // naming a live agent is a pick in the wrong place, not a typo
  throw new BadRequest(
    agents.byName(name) === null
      ? noAgentNamed(summonWord(text)!)
      : NEW_CHAT_PICKS,
  );
}

// whether a queued message, checked when it was queued, summons
export const summons =
  (chatAgent: string) =>
  (text: string): boolean => {
    const name = summonName(text);
    return name !== null && name !== chatAgent;
  };

// a queued summon whose agent was retired since it was checked
export function summonGone(
  agents: Pick<SummonAgents, "byName">,
  chatAgent: string,
  text: string,
): boolean {
  return summons(chatAgent)(text) && agents.byName(summonName(text)!) === null;
}

// a summoned turn never compacts, so it is refused when the chat's last
// round, of whichever agent, already passes where its model compacts
export function refuseTooLong(
  agent: AgentRow,
  size: number | null,
  reserve: number,
): void {
  const threshold = compactsAt(agent.model.contextLength, reserve);
  if (threshold !== null && size !== null && size >= threshold) {
    throw new BadRequest(`the chat is too long for ${agent.name}`);
  }
}

// the summoned agent a regenerate reruns on; a retired one is gone and
// the user summons again
export function summonedAgain(
  agents: Pick<SummonAgents, "byId">,
  agentId: string,
  retiredName: string | undefined,
): AgentRow {
  const agent = agents.byId(agentId);
  if (agent === null) {
    throw new BadRequest(
      retiredName === undefined
        ? "the agent is gone"
        : `the agent ${retiredName} is gone`,
    );
  }
  return agent;
}

// the rows one turn opens with: those before the first summon, or the
// summon alone when it comes first; the rest wait for the next turn
export function turnBatch<T extends { text: string }>(
  rows: readonly T[],
  summons: (text: string) => boolean,
): T[] {
  const at = rows.findIndex((row) => summons(row.text));
  if (at < 0) return [...rows];
  return rows.slice(0, at === 0 ? 1 : at);
}

export type SummonDeps = LookupDeps & {
  sessions: Pick<SessionStore, "send" | "agents" | "messages">;
  agents: SummonAgents;
  providers: { byId(id: string): { wire: Wire } | null };
  limits: { current(): { contextReserve: number } };
};

// the chat's size: its last round's prompt, or after a summary the
// summary and the tail the chat's agent replays next, picked as its
// history picks it. The system prompt and schemas are not known here,
// so the budget is sized against the summary alone, which can only
// make the tail longer
function chatSize(
  deps: SummonDeps,
  sessionId: string,
  chatAgent: AgentRow,
  replaced: string | null,
): number | null {
  const last = lastPrompt(deps.db, sessionId, replaced);
  if (last === null || !last.summary) return last?.tokens ?? null;
  const rows = deps.sessions
    .messages(sessionId)
    .filter((row) => row.sendId !== replaced);
  const cut = lastSummary(rows);
  if (cut < 0) return last.tokens;
  const { lookups } = roundLookups(deps);
  const reserve = deps.limits.current().contextReserve;
  const tail = tailOf(
    rows,
    cut,
    tailBudget(chatAgent.model.contextLength, reserve, last.tokens),
    {
      username: "",
      userId: "",
      providerId: chatAgent.providerId,
      model: chatAgent.model.id,
      offered: { mcp: [], skills: { block: "", skills: [] } },
      agentId: chatAgent.id,
      summoned: null,
    },
    lookups,
    lookups.turnsOf(sessionId),
    deps.providers.byId(chatAgent.providerId)?.wire ?? null,
  );
  return last.tokens + tail.tokens;
}

// the agent a chat's turn runs on and, when summoned, the chat's agent
// its prompt names
export type TurnAgent = { agent: AgentRow; summoned: string | null };

const summoning = (
  deps: SummonDeps,
  sessionId: string,
  agent: AgentRow,
  chatAgent: AgentRow,
  // the send a regenerate replaces
  replaced: string | null = null,
): TurnAgent => {
  refuseTooLong(
    agent,
    chatSize(deps, sessionId, chatAgent, replaced),
    deps.limits.current().contextReserve,
  );
  return { agent, summoned: chatAgent.name };
};

// a turn of new messages: the chat's agent unless the first word
// summons another
export function turnAgent(
  deps: SummonDeps,
  sessionId: string,
  chatAgent: AgentRow,
  texts: readonly string[],
): TurnAgent {
  const agent = turnSummon(deps.agents, chatAgent.name, texts);
  return agent === null
    ? { agent: chatAgent, summoned: null }
    : summoning(deps, sessionId, agent, chatAgent);
}

// a regenerate reruns on the send's agent and flag, never the text
export function regeneratedAgent(
  deps: SummonDeps,
  sessionId: string,
  chatAgent: AgentRow,
  sendId: string,
): TurnAgent {
  const turn = deps.sessions.send(sendId);
  if (turn === null || !turn.summoned) {
    return { agent: chatAgent, summoned: null };
  }
  const retired = deps.sessions
    .agents(sessionId)
    .find((agent) => agent.id === turn.agentId)?.name;
  const agent = summonedAgain(deps.agents, turn.agentId, retired);
  return summoning(deps, sessionId, agent, chatAgent, sendId);
}
