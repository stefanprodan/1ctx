// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { OWN_MEMORY_GUIDANCE } from "../../shared/automation-defaults.ts";
import type { AutomationProposal } from "../../shared/contracts/automation-draft.ts";
import { type Db, transact } from "../db/index.ts";
import { BadRequest, ToolError } from "../lib/errors.ts";
import { draftChanged } from "./draft-events.ts";
import type { AutomationDraftStore } from "./draft-store.ts";
import { parsePatchAutomation, parseSaveAutomation } from "./parse.ts";
import { checkSchedule } from "./schedule.ts";
import type { AutomationStore } from "./store.ts";

export type ProposalInput = {
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
};

// a proposal never stores a guidance nothing reads
const UNREAD_MEMORY =
  "memoryGuidance needs ownMemory. Leave it out when the task keeps no memory.";

export function proposeTask(
  deps: {
    db: Db;
    store: AutomationStore;
    drafts: AutomationDraftStore;
    runDeadlineMs(): number;
  },
  input: ProposalInput,
): string {
  return transact(deps.db, () => {
    const current =
      input.automationId === null ? null : deps.store.byId(input.automationId);
    if (
      input.action !== "create" &&
      (current === null || current.projectId !== input.projectId)
    ) {
      throw new BadRequest("no scheduled task with that id in this project");
    }
    let proposal: AutomationProposal;
    if (input.action === "create") {
      const fields = parseSaveAutomation(input.fields);
      if (!fields.ownMemory && fields.memoryGuidance !== "") {
        throw new BadRequest(UNREAD_MEMORY);
      }
      checkSchedule(fields.schedule, fields.tz, input.now);
      if (
        fields.deadlineMs !== null &&
        fields.deadlineMs > deps.runDeadlineMs()
      ) {
        throw new BadRequest("deadline is above the run limit");
      }
      proposal = { action: "create", fields };
    } else if (input.action === "update") {
      const { patch } = parsePatchAutomation({
        ...input.fields,
        editRevision: current!.editRevision,
      });
      const next = { ...current!, ...patch };
      if (!next.ownMemory && (patch.memoryGuidance ?? "") !== "") {
        throw new BadRequest(UNREAD_MEMORY);
      }
      if (
        (patch.attentionGuidance ?? "") !== "" &&
        next.attentionMode === "off"
      ) {
        throw new ToolError(
          `Attention is off on [${current!.name}](/automations/${current!.id}). Open it to turn attention on first.`,
          "task needs page edit",
        );
      }
      // as the page's pickMemory: turning own memory on fills a blank
      // guidance, and turning it off drops an unchanged default, so a
      // later turn-on takes the default of that day
      if (patch.memoryGuidance === undefined && patch.ownMemory !== undefined) {
        if (
          patch.ownMemory &&
          !current!.ownMemory &&
          current!.memoryGuidance.trim() === ""
        ) {
          patch.memoryGuidance = OWN_MEMORY_GUIDANCE;
        }
        if (
          !patch.ownMemory &&
          current!.ownMemory &&
          current!.memoryGuidance === OWN_MEMORY_GUIDANCE
        ) {
          patch.memoryGuidance = "";
        }
      }
      if (
        current!.agentRetired ||
        (next.deadlineMs !== null && next.deadlineMs > deps.runDeadlineMs())
      ) {
        throw new ToolError(
          `Open [${current!.name}](/automations/${current!.id}) to change its agent or deadline first.`,
          "task needs page edit",
        );
      }
      checkSchedule(next.schedule, next.tz, input.now);
      proposal = { action: "update", fields: patch };
    } else {
      proposal = { action: input.action, fields: {} };
    }
    const name =
      proposal.action === "create" || proposal.action === "update"
        ? proposal.fields.name
        : undefined;
    if (
      name !== undefined &&
      deps.store.nameTaken(input.projectId, name, current?.id)
    ) {
      const taken = deps.store
        .byProject(input.projectId)
        .find((row) => row.name === name)!;
      throw new ToolError(
        `Name is taken: [${taken.name}](/automations/${taken.id}). Read it with show.`,
        "task name taken",
      );
    }
    const draft = deps.drafts.create({
      ...input,
      ...proposal,
      editRevision: current?.editRevision ?? null,
    });
    return { result: draft.id, events: [draftChanged(deps.db, draft.id)] };
  });
}
