// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../src/shared/contracts/automation.ts";
import { type ChatApp, type Script, tick } from "./chat.ts";

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
    memoryGuidance: string;
    disabledCapabilities: string[];
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
  ...(fields.disabledCapabilities === undefined
    ? {}
    : { disabledCapabilities: fields.disabledCapabilities }),
  ...(fields.memoryGuidance === undefined
    ? {}
    : { memoryGuidance: fields.memoryGuidance }),
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

// a manual run of an automation: its session id and the script driving
// the run's first provider round
export async function startRun(
  chat: ChatApp,
  automationId: string,
): Promise<{ sessionId: string; main: Script }> {
  const pending = chat.scripted.next();
  const response = await chat.member.call(
    "POST",
    `/api/automations/${automationId}/run`,
  );
  if (response.status !== 201) {
    throw new Error(
      `run now answered ${response.status}: ${await response.text()}`,
    );
  }
  const detail = await response.json();
  return { sessionId: detail.session.id as string, main: await pending };
}

// wait until the session is no longer running and answer its row
export async function settleRun(chat: ChatApp, sessionId: string) {
  for (let i = 0; i < 200; i++) {
    const session = chat.app.sessions.byId(sessionId);
    if (session?.status !== "running") return session;
    await tick();
  }
  throw new Error("run did not settle");
}
