// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The system prompt: the agent's prompt, the project and the user with
// what was written about each, and the date. The project comes before
// the user, who changes with the author of a team chat, and a day, not
// a time, so the prefix holds until midnight and a provider's cache
// with it. Memory, knowledge and skills arrive through ports wired to
// empty until their slices.

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
    "projectName" | "projectKind" | "projectDescription" | "username"
  >,
): string {
  const about = policy.projectDescription.trim();
  const where =
    policy.projectKind === "personal"
      ? `@${policy.username}'s personal project`
      : `the ${policy.projectName} project`;
  return `You work in ${where}${about === "" ? "." : `: ${about}`}`;
}

function automationLine(
  automation: NonNullable<SendPolicy["automation"]>,
): string {
  const at = new Intl.DateTimeFormat("en-GB", {
    timeZone: automation.tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(automation.dueAt);
  return `This session was opened by the ${automation.name} automation from its ${automation.source} event at ${at} in ${automation.tz}. Nobody is typing back.`;
}

function userLine(fullName: string, username: string, about: string): string {
  const said = about.trim();
  return `You talk to @${username} (${fullName})${said === "" ? "." : `: ${said}`}`;
}

export function systemPrompt(
  policy: Pick<
    SendPolicy,
    | "prompt"
    | "projectName"
    | "projectKind"
    | "projectDescription"
    | "fullName"
    | "username"
    | "about"
    | "automation"
  >,
  now: number,
): string {
  const parts: string[] = [];
  if (policy.prompt.trim() !== "") parts.push(policy.prompt.trim());
  const context = [projectLine(policy)];
  if (policy.automation !== null) {
    context.push(automationLine(policy.automation));
  }
  context.push(userLine(policy.fullName, policy.username, policy.about));
  parts.push(context.join("\n"));
  parts.push(dateLine(now));
  return parts.join("\n\n");
}
