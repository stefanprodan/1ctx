// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who a fire acts as and the event its run starts from.

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type { EventSource } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import { type ProjectRow, visible } from "../projects/index.ts";
import type { Event } from "../runner/index.ts";
import type { UserRow } from "../users/index.ts";
import type { Held } from "./check.ts";
import { checkMessage } from "./check-message.ts";
import { RETIRED } from "./store.ts";

export type FireDeps = {
  users: { byId(id: string): UserRow | null };
  projects: {
    byId(id: string): ProjectRow | null;
    isMember(projectId: string, userId: string): boolean;
  };
  agents: { byId(id: string): AgentRow | null };
  // how much of a new answer the first message holds
  resultCut(): number;
};

type Resolved = { user: UserRow; project: ProjectRow; agent: AgentRow };

// a scheduled fire acts as the owner, who must still see the project
export function ownerFor(deps: FireDeps, row: AutomationSummary): Resolved {
  const user = deps.users.byId(row.ownerId);
  if (user === null || user.disabled) throw new Conflict("owner unavailable");
  const project = deps.projects.byId(row.projectId);
  if (
    project === null ||
    !visible(
      project,
      { userId: user.id, role: user.role },
      deps.projects.isMember(project.id, user.id),
    )
  ) {
    throw new Conflict("owner cannot see project");
  }
  const agent = deps.agents.byId(row.agentId);
  if (agent === null) throw new Conflict("no such agent");
  return { user, project, agent };
}

export function manualFor(
  deps: FireDeps,
  row: AutomationSummary,
  actor: UserRow,
): Resolved {
  const project = deps.projects.byId(row.projectId);
  if (project === null) throw new Conflict("no such automation");
  if (row.agentRetired) throw new Conflict(RETIRED);
  const agent = deps.agents.byId(row.agentId);
  if (agent === null) throw new BadRequest("no such agent");
  return { user: actor, project, agent };
}

function firstMessage(
  deps: FireDeps,
  row: AutomationSummary,
  agent: AgentRow,
  held: Held | undefined,
): Pick<Event, "instructions" | "kept"> {
  if (held === undefined || held.answer.result !== "200") {
    return { instructions: row.instructions };
  }
  const start = checkMessage(row.instructions, held.answer.body, {
    resultCut: deps.resultCut(),
    window: agent.model.contextLength,
  });
  return { instructions: start.text, kept: [start.kept] };
}

export function eventFor(
  deps: FireDeps,
  row: AutomationSummary,
  source: EventSource,
  dueAt: number,
  resolved: Resolved,
  held?: Held,
): Event {
  return {
    ...firstMessage(deps, row, resolved.agent, held),
    source,
    automation: {
      id: row.id,
      name: row.name,
      tz: row.tz,
      ownMemory: row.ownMemory,
      memoryGuidance: row.memoryGuidance,
      attentionMode: row.attentionMode,
      attentionGuidance: row.attentionGuidance,
      disabledCapabilities: row.disabledCapabilities,
    },
    dueAt,
    deadlineMs: row.deadlineMs,
    ...resolved,
  };
}
