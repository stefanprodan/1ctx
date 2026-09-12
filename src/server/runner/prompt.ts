// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The system prompt: the agent's prompt, what the user said about
// themself, and the date. A day, not a time, so the prefix holds until
// midnight and a provider's cache with it. Memory, knowledge and skills
// arrive through ports wired to empty until their slices.

import type { SendPolicy } from "./policy.ts";

export const ABOUT_LEAD = "About the user, in their words:";

// the calendar day in UTC; the user's zone comes with the profile later
export function dateLine(now: number): string {
  return `Today is ${new Date(now).toISOString().slice(0, 10)}.`;
}

export function systemPrompt(
  policy: Pick<SendPolicy, "prompt" | "about">,
  now: number,
): string {
  const parts: string[] = [];
  if (policy.prompt.trim() !== "") parts.push(policy.prompt.trim());
  if (policy.about.trim() !== "") {
    parts.push(`${ABOUT_LEAD}\n${policy.about.trim()}`);
  }
  parts.push(dateLine(now));
  return parts.join("\n\n");
}
