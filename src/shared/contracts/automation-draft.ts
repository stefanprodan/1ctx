// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { isAttentionMode } from "../words.ts";
import type { AutomationSummary } from "./automation.ts";

export type ProposalFields = Pick<
  AutomationSummary,
  "name" | "instructions" | "schedule" | "tz" | "once"
>;

export type CreateTaskFields = ProposalFields &
  Pick<
    AutomationSummary,
    | "agentId"
    | "deadlineMs"
    | "retentionDays"
    | "ownMemory"
    | "memoryGuidance"
    | "attentionMode"
    | "attentionGuidance"
    | "rerunOnRestart"
    | "disabledCapabilities"
  >;

export type AutomationProposal =
  | { action: "create"; fields: CreateTaskFields }
  | { action: "update"; fields: Partial<ProposalFields> }
  | { action: "suspend" | "resume" | "run"; fields: Record<string, never> };

export type DraftState =
  | "pending"
  | "confirmed"
  | "dismissed"
  | "stale"
  | "expired";

export type AutomationDraft = AutomationProposal & {
  id: string;
  sendId: string;
  messageId: string;
  automationId: string | null;
  agentId: string;
  state: DraftState;
  askedBy: { id: string; username: string };
  decidedBy: { id: string; username: string } | null;
  decidedAt: number | null;
  createdAutomationId: string | null;
  runSessionId: string | null;
  createdAt: number;
  expiresAt: number;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown) => typeof value === "string" && value !== "";
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableId = (value: unknown) => value === null || id(value);
const person = (value: unknown) =>
  object(value) &&
  id(value.id) &&
  id(value.username) &&
  Object.keys(value).length === 2;
const text = (value: unknown) => typeof value === "string";
const boolean = (value: unknown) => typeof value === "boolean";
const fieldGuards = {
  name: text,
  instructions: text,
  schedule: text,
  tz: text,
  once: boolean,
  agentId: id,
  deadlineMs: (value: unknown) => value === null || integer(value),
  retentionDays: integer,
  ownMemory: boolean,
  memoryGuidance: text,
  attentionMode: (value: unknown) =>
    text(value) && isAttentionMode(value as string),
  attentionGuidance: text,
  rerunOnRestart: boolean,
  disabledCapabilities: (value: unknown) =>
    Array.isArray(value) && value.every(text),
} satisfies Record<keyof CreateTaskFields, (value: unknown) => boolean>;

function proposal(value: Record<string, unknown>): boolean {
  if (!object(value.fields)) return false;
  const fields = value.fields;
  const keys = Object.keys(fields);
  if (value.action === "create") {
    return (
      keys.length === Object.keys(fieldGuards).length &&
      Object.entries(fieldGuards).every(([key, guard]) => guard(fields[key]))
    );
  }
  if (value.action === "update") {
    return (
      keys.length > 0 &&
      keys.every(
        (key) =>
          ["name", "instructions", "schedule", "tz", "once"].includes(key) &&
          fieldGuards[key as keyof ProposalFields](fields[key]),
      )
    );
  }
  return (
    ["suspend", "resume", "run"].includes(value.action as string) &&
    keys.length === 0
  );
}

export function isAutomationDraft(value: unknown): value is AutomationDraft {
  return (
    object(value) &&
    id(value.id) &&
    id(value.sendId) &&
    id(value.messageId) &&
    nullableId(value.automationId) &&
    id(value.agentId) &&
    ["pending", "confirmed", "dismissed", "stale", "expired"].includes(
      value.state as string,
    ) &&
    person(value.askedBy) &&
    (value.decidedBy === null || person(value.decidedBy)) &&
    (value.decidedAt === null || integer(value.decidedAt)) &&
    nullableId(value.createdAutomationId) &&
    nullableId(value.runSessionId) &&
    integer(value.createdAt) &&
    integer(value.expiresAt) &&
    proposal(value) &&
    Object.keys(value).length === 15
  );
}
