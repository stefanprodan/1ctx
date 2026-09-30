// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The system prompt: the agent's name and project, the agent's prompt,
// the user with what was written about them, the skills catalog and the
// date. The model learns who it is and where before its instructions, as
// a harness's prompt opens. A run belongs to its project, not to a
// person, so the run's line takes the user's place.
// The user comes after what is fixed per agent and project, since the
// user changes with the author of a team chat, and a day, not a time, so
// the prefix holds until midnight and a provider's cache with it. The
// skills catalog arrives on the policy's offered snapshot; memory and
// knowledge are captured once per send so a tool's writes cannot move
// the prefix between rounds.

import {
  KNOWLEDGE,
  KNOWLEDGE_OFF_LINE,
  MEMORY,
  MEMORY_OFF_LINE,
  mcpOffLine,
  skillsOffLine,
  VISUALIZE,
  VISUALIZE_OFF_LINE,
  WEB,
  WEB_OFF_LINE,
} from "../../shared/capabilities.ts";
import { knowledgeBlock } from "../../shared/knowledge.ts";
import { memoryBlock } from "../../shared/memory.ts";
import type { SendPolicy } from "./policy.ts";

// the calendar day in UTC; the user's zone comes with the profile later
export function dateLine(now: number): string {
  return `Today is ${new Date(now).toISOString().slice(0, 10)}.`;
}

// a personal project is only ever its owner's, who is the one talking,
// and every one is named personal, so the owner names it
function projectLine(
  policy: Pick<
    SendPolicy,
    | "agentName"
    | "projectName"
    | "projectKind"
    | "projectDescription"
    | "username"
  >,
): string {
  const about = policy.projectDescription.trim();
  const where =
    policy.projectKind === "personal"
      ? `@${policy.username}'s personal project`
      : `the ${policy.projectName} project`;
  return `You are ${policy.agentName}, an agent in ${where}${about === "" ? "." : `: ${about}`}`;
}

// a run has nobody to answer it, so it is told to finish on its own
function automationLine(
  automation: NonNullable<SendPolicy["automation"]>,
): string {
  // numbers only, "2026-09-14 20:10", since runtimes word a medium date
  // differently and the prompt should not move with them
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: automation.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(automation.dueAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const at = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  const kind = automation.source === "schedule" ? "scheduled" : "manual";
  return `This is a ${kind} run of the ${automation.name} automation, started at ${at} ${automation.tz}. You run autonomously. Do not ask questions. Do the task and stop.`;
}

// after the agent's prompt, so the fixed prefix stays the agent's own
export function summonedLine(chatAgent: string): string {
  return `You were summoned for one turn into a chat whose agent is ${chatAgent}. Answers by other agents are marked with their names in brackets.`;
}

function userLine(
  policy: Pick<SendPolicy, "fullName" | "username" | "about" | "tz">,
): string {
  const said = policy.about.trim();
  return `You talk to @${policy.username} (${policy.fullName}), in the ${policy.tz} time zone${said === "" ? "." : `: ${said}`}`;
}

export function systemPrompt(
  policy: Pick<
    SendPolicy,
    | "prompt"
    | "agentName"
    | "summoned"
    | "projectName"
    | "projectKind"
    | "projectDescription"
    | "fullName"
    | "username"
    | "about"
    | "tz"
    | "automation"
    | "offered"
    | "projectMemory"
    | "automationMemory"
    | "knowledge"
    | "disabledCapabilities"
    | "mcpOff"
    | "skillsOff"
  >,
  now: number,
  mcpNote = "",
): string {
  const parts = [projectLine(policy)];
  if (policy.prompt.trim() !== "") parts.push(policy.prompt.trim());
  if (policy.summoned !== null) parts.push(summonedLine(policy.summoned));
  parts.push(
    policy.automation === null
      ? userLine(policy)
      : automationLine(policy.automation),
  );
  if (policy.offered.skills.block !== "") {
    parts.push(policy.offered.skills.block);
  }
  if (policy.offered.mcpCatalog !== "") {
    parts.push(policy.offered.mcpCatalog);
  }
  if (policy.offered.mcpPrompt.text !== "") {
    parts.push(policy.offered.mcpPrompt.text);
  }
  const projectMemory = memoryBlock("project-memory", policy.projectMemory);
  if (projectMemory !== "") parts.push(projectMemory);
  if (policy.automation?.ownMemory) {
    parts.push(memoryBlock("automation-memory", policy.automationMemory));
  }
  // a model that cannot call the tool is not told of the files behind it
  const bash = policy.offered.tools.some((tool) => tool.name === "bash");
  const docsOff = policy.disabledCapabilities.includes(KNOWLEDGE);
  if (bash && !docsOff) {
    parts.push(knowledgeBlock(policy.knowledge.files, policy.knowledge.recent));
  }
  parts.push(dateLine(now));
  if (
    policy.disabledCapabilities.includes(WEB) &&
    policy.offered.tools.length > 0
  ) {
    parts.push(WEB_OFF_LINE);
  }
  if (
    policy.disabledCapabilities.includes(VISUALIZE) &&
    policy.offered.tools.length > 0
  ) {
    parts.push(VISUALIZE_OFF_LINE);
  }
  if (docsOff && bash) parts.push(KNOWLEDGE_OFF_LINE);
  // a run is never offered the tool, so the key means nothing there
  if (
    policy.disabledCapabilities.includes(MEMORY) &&
    policy.offered.tools.length > 0 &&
    policy.automation === null
  ) {
    parts.push(MEMORY_OFF_LINE);
  }
  if (policy.mcpOff.length > 0) parts.push(mcpOffLine(policy.mcpOff));
  if (policy.skillsOff.length > 0) {
    parts.push(skillsOffLine(policy.skillsOff));
  }
  if (mcpNote !== "") parts.push(mcpNote);
  return parts.join("\n\n");
}
