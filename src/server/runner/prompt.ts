// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The system prompt; its order is fixed in docs/sessions.md.

import {
  KNOWLEDGE,
  KNOWLEDGE_OFF_LINE,
  MEMORY,
  MEMORY_OFF_LINE,
  mcpOffLine,
  reposOffLine,
  skillsOffLine,
  VISUALIZE,
  VISUALIZE_OFF_LINE,
  WEB,
  WEB_OFF_LINE,
} from "../../shared/capabilities.ts";
import { knowledgeBlock } from "../../shared/knowledge.ts";
import { memoryBlock } from "../../shared/memory.ts";
import { localMinute } from "../lib/clock.ts";
import { offers, type SendPolicy } from "./policy.ts";

// the UTC day, so the prefix holds until midnight for every author
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
  const at = localMinute(automation.tz)(automation.dueAt);
  const kind = automation.source === "manual" ? "manual" : "scheduled";
  return `This is a ${kind} run of the ${automation.name} automation, started at ${at} ${automation.tz}. You run autonomously. Do not ask questions. Do the task and stop.`;
}

// after the agent's prompt, so the fixed prefix stays the agent's own
export function summonedLine(chatAgent: string): string {
  return `You were summoned for one turn into a chat whose agent is ${chatAgent}. Answers by other agents are marked with their names in brackets. Write yours without a mark.`;
}

function userLine(
  policy: Pick<SendPolicy, "fullName" | "username" | "about" | "tz">,
): string {
  const said = policy.about.trim();
  return `You talk to @${policy.username} (${policy.fullName}), in the ${policy.tz} time zone${said === "" ? "." : `: ${said}`}`;
}

// what a send's repositories add: the ones off that a turn read, and a
// line per branch that moved since the chat's last turn
export type RepoLines = {
  off: readonly string[];
  moved: readonly string[];
};

export const NO_REPO_LINES: RepoLines = { off: [], moved: [] };

export type PromptPolicy = Pick<
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
>;

export function systemPrompt(
  policy: PromptPolicy,
  now: number,
  mcpNote = "",
  repos: RepoLines = NO_REPO_LINES,
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
  const bash = offers(policy.offered, "bash");
  const docsOff = policy.disabledCapabilities.includes(KNOWLEDGE);
  if (bash && !docsOff) {
    parts.push(knowledgeBlock(policy.knowledge.empty));
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
  if (repos.off.length > 0) parts.push(reposOffLine(repos.off));
  if (repos.moved.length > 0) parts.push(repos.moved.join("\n"));
  if (mcpNote !== "") parts.push(mcpNote);
  return parts.join("\n\n");
}
