// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../src/shared/contracts/automation.ts";
import type { ChatApp } from "./chat.ts";

export const automationBody = (
  chat: ChatApp,
  fields: Partial<{
    name: string;
    instructions: string;
    schedule: string;
    tz: string;
    deadlineMs: number | null;
    retentionDays: number;
    projectMemory: boolean;
    ownMemory: boolean;
  }> = {},
) => ({
  name: fields.name ?? "daily-run",
  agentId: chat.agentId,
  instructions: fields.instructions ?? "check the system",
  schedule: fields.schedule ?? "0 * * * *",
  tz: fields.tz ?? "UTC",
  deadlineMs: fields.deadlineMs ?? null,
  retentionDays: fields.retentionDays ?? 30,
  projectMemory: fields.projectMemory ?? false,
  ownMemory: fields.ownMemory ?? false,
});

export async function createAutomation(
  chat: ChatApp,
  fields: Parameters<typeof automationBody>[1] = {},
): Promise<AutomationSummary> {
  const response = await chat.member.call(
    "POST",
    `/api/projects/${chat.projectId}/automations`,
    { body: automationBody(chat, fields) },
  );
  if (response.status !== 201) {
    throw new Error(
      `automation create answered ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()).automation;
}
