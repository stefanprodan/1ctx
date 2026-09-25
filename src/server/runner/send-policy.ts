// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The policy of one send from the areas' word at its start: the limits,
// the provider, the knowledge base and the notes. A chat's prompt
// carries its own snapshot of the project's note, so another chat's save
// never moves its cached prefix; a run reads the note live.

import type { Wire } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Limits } from "../limits/index.ts";
import type { MemoryCapability } from "../memory/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { UserRow } from "../users/index.ts";
import type { Event } from "./event.ts";
import { buildPolicy, type SendPolicy, type ToolsPort } from "./policy.ts";

export type SendPolicyDeps = {
  clock: Clock;
  limits: { current(): Limits };
  providers: { byId(id: string): { name: string; wire: Wire } | null };
  tools: ToolsPort;
  knowledge: { snapshot(projectId: string): SendPolicy["knowledge"] };
  memory: Pick<MemoryCapability, "read" | "view">;
};

export function sendPolicy(
  deps: SendPolicyDeps,
  fields: {
    sessionId: string;
    project: ProjectRow;
    user: UserRow;
    agent: AgentRow;
    event?: Event | null;
    offerTools?: boolean;
    disabledCapabilities?: readonly string[];
  },
): SendPolicy {
  const { sessionId, project, user, agent } = fields;
  const event = fields.event ?? null;
  const limits = deps.limits.current();
  const automation =
    event === null
      ? null
      : { ...event.automation, source: event.source, dueAt: event.dueAt };
  const provider = deps.providers.byId(agent.providerId);
  return buildPolicy({
    project,
    user,
    agent,
    providerName: provider?.name,
    wire: provider?.wire ?? null,
    now: deps.clock(),
    tools: (fields.offerTools ?? true) && agent.model.tools ? deps.tools : null,
    disabledCapabilities: fields.disabledCapabilities ?? [],
    limits,
    automation,
    sessionId: event === null ? sessionId : null,
    knowledge: deps.knowledge.snapshot(project.id),
    projectMemory:
      (event === null ? deps.memory.view(sessionId) : null) ??
      deps.memory.read(project.id, null).entries,
    automationMemory:
      automation?.ownMemory === true
        ? deps.memory.read(project.id, automation.id).entries
        : [],
    deadlineMs:
      event === null
        ? limits.sendDeadlineMs
        : Math.min(
            event.deadlineMs ?? limits.runDeadlineMs,
            limits.runDeadlineMs,
          ),
  });
}
