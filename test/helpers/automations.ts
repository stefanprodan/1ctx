// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../src/shared/contracts/automation.ts";
import type { AttentionMode } from "../../src/shared/words.ts";
import {
  type ChatApp,
  type Script,
  sessionSettled,
  waitScript,
} from "./chat.ts";

// set to off unless the test names a mode, so a finished run asks no
// attention step of the scripted provider
export const automationBody = (
  chat: ChatApp,
  fields: Partial<{
    name: string;
    instructions: string;
    schedule: string;
    tz: string;
    deadlineMs: number | null;
    retentionDays: number;
    ownMemory: boolean;
    memoryGuidance: string;
    disabledCapabilities: string[];
    attentionMode: AttentionMode;
    attentionGuidance: string;
    once: boolean;
    rerunOnRestart: boolean;
  }> = {},
) => ({
  name: fields.name ?? "daily-run",
  agentId: chat.agentId,
  instructions: fields.instructions ?? "check the system",
  schedule: fields.schedule ?? "0 * * * *",
  tz: fields.tz ?? "UTC",
  deadlineMs: fields.deadlineMs ?? null,
  retentionDays: fields.retentionDays ?? 30,
  ownMemory: fields.ownMemory ?? false,
  ...(fields.disabledCapabilities === undefined
    ? {}
    : { disabledCapabilities: fields.disabledCapabilities }),
  ...(fields.memoryGuidance === undefined
    ? {}
    : { memoryGuidance: fields.memoryGuidance }),
  attentionMode: fields.attentionMode ?? "off",
  ...(fields.attentionGuidance === undefined
    ? {}
    : { attentionGuidance: fields.attentionGuidance }),
  ...(fields.once === undefined ? {} : { once: fields.once }),
  ...(fields.rerunOnRestart === undefined
    ? {}
    : { rerunOnRestart: fields.rerunOnRestart }),
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

// the session's row once it is no longer running
export function settleRun(chat: ChatApp, sessionId: string) {
  return sessionSettled(chat.app, sessionId);
}

// the attention step's verdict call, closed: needed false unless a
// reason is given
export function verdict(reason?: string, id = "v1") {
  return (script: Script) => {
    script.toolRound([
      {
        id,
        name: "attention",
        arguments: JSON.stringify(
          reason === undefined ? { needed: false } : { needed: true, reason },
        ),
      },
    ]);
    script.end();
  };
}

// a run's answer, then its attention step's verdict, needed false unless
// the test drives it; the step's script
export async function answerRun(
  chat: ChatApp,
  main: Script,
  answer: string,
  step: (script: Script) => void = verdict(),
): Promise<Script> {
  const before = chat.scripted.scripts.length;
  main.reply(answer);
  const script = await waitScript(chat.scripted, before + 1);
  step(script);
  return script;
}
