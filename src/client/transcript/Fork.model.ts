// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fork menu's rows: the project's agents with the session's own
// first, so the one-click case is the top row.

import type { AgentSummary } from "../../shared/contracts/agent.ts";

export function forkChoices(
  agents: AgentSummary[],
  agentId: string | null,
): AgentSummary[] {
  const own = agents.filter((a) => a.id === agentId);
  return [...own, ...agents.filter((a) => a.id !== agentId)];
}

// the menu's height: a row per agent plus its padding, or the one line
// it shows with no agents
const FORK_ROW_PX = 38;
const FORK_PAD_PX = 12;
const forkMenuHeight = (rows: number): number =>
  Math.max(rows, 1) * FORK_ROW_PX + FORK_PAD_PX;

// whether the menu rises over its button: when it would reach past the
// limit under the button (the foot's top, or the window's bottom)
export function opensUp(
  buttonBottom: number,
  limit: number,
  rows: number,
): boolean {
  return buttonBottom + forkMenuHeight(rows) > limit;
}
