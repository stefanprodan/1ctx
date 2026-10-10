// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { AUTOMATION_DEFAULTS } from "../../../shared/automation-defaults.ts";
import { DRAFTS_PER_SEND } from "../../../shared/automation-limits.ts";
import { AUTOMATIONS, MEMORY } from "../../../shared/capabilities.ts";
import {
  type AutomationProposal,
  PROPOSAL_FIELDS,
} from "../../../shared/contracts/automation-draft.ts";
import { messageOf, ToolError } from "../../lib/errors.ts";
import type { ToolBudget, ToolContext } from "../types.ts";

export const PROPOSAL_ACTIONS = {
  create: ["action", ...PROPOSAL_FIELDS],
  update: ["action", "id", ...PROPOSAL_FIELDS],
  suspend: ["action", "id"],
  resume: ["action", "id"],
  run: ["action", "id"],
} as const;

export type ProposalCall = {
  action: AutomationProposal["action"];
  id: string | null;
  fields: Record<string, unknown>;
};

export type ProposalsPort = {
  userZone(userId: string): string;
  propose(input: {
    projectId: string;
    sessionId: string;
    sendId: string;
    messageId: string;
    userId: string;
    agentId: string;
    action: AutomationProposal["action"];
    automationId: string | null;
    fields: Record<string, unknown>;
    now: number;
  }): string | Promise<string>;
};

// Shared by every round and parallel call, without keeping ended sends alive.
const counts = new WeakMap<ToolBudget, number>();

export async function propose(
  port: ProposalsPort,
  call: ProposalCall,
  ctx: ToolContext,
): Promise<string> {
  const actor = ctx.actor!;
  const count = counts.get(ctx.budget) ?? 0;
  if (count >= DRAFTS_PER_SEND)
    throw new Error("this turn already has 5 task proposals");
  counts.set(ctx.budget, count + 1);
  let written = false;
  try {
    const fields =
      call.action === "create"
        ? {
            ...AUTOMATION_DEFAULTS,
            tz: port.userZone(actor.userId),
            // the default guidance is for own memory, so a task
            // without one stores none
            ...(call.fields.ownMemory === false ? { memoryGuidance: "" } : {}),
            ...call.fields,
            agentId: actor.agentId,
            disabledCapabilities: ctx.disabledCapabilities.filter(
              (key) => key !== AUTOMATIONS && key !== MEMORY,
            ),
          }
        : call.fields;
    await port.propose({
      projectId: actor.projectId,
      sessionId: actor.sessionId,
      sendId: ctx.sendId,
      messageId: ctx.messageId,
      userId: actor.userId,
      agentId: actor.agentId,
      action: call.action,
      automationId: call.id,
      fields,
      now: ctx.now(),
    });
    written = true;
    return (
      "Proposed. It waits for a person to confirm in this chat." +
      (call.action === "suspend" ? " A run already going keeps going." : "")
    );
  } catch (error) {
    throw error instanceof ToolError
      ? error
      : new ToolError(messageOf(error), "task proposal refused");
  } finally {
    if (!written) counts.set(ctx.budget, (counts.get(ctx.budget) ?? 1) - 1);
  }
}
