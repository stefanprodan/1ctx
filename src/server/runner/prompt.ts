// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The system prompt: the agent's prompt, the project and the user with
// what was written about each, and the date. A run belongs to its
// project, not to a person, so the run's line takes the user's place.
// The project comes before the user, who changes with the author of a
// team chat, and a day, not a time, so the prefix holds until midnight
// and a provider's cache with it. Memory, knowledge and skills arrive through ports wired to
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
  const context = [
    projectLine(policy),
    policy.automation === null
      ? userLine(policy.fullName, policy.username, policy.about)
      : automationLine(policy.automation),
  ];
  parts.push(context.join("\n"));
  parts.push(dateLine(now));
  return parts.join("\n\n");
}
