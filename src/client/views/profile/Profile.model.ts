// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the profile forms check before they call: the same rules the
// server applies, so a slip is caught without a round trip, and the
// server's word is still the last.

import type { Profile } from "../../../shared/contracts/user.ts";
import { isFullName, MAX_ABOUT, MAX_FULL_NAME } from "../../../shared/words.ts";

// the sections' lines, the same while the profile waits and once it lands
export const ABOUT_TEXT = "What agents should know about you.";

export function fullNameProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter a name";
  if (trimmed.length > MAX_FULL_NAME)
    return `Keep it under ${MAX_FULL_NAME} characters`;
  if (!isFullName(trimmed)) return "One line only";
  return null;
}

export function aboutProblem(value: string): string | null {
  if (value.length > MAX_ABOUT) return `Keep it under ${MAX_ABOUT} characters`;
  return null;
}

// which field of the details a server refusal names
export function detailsFieldOf(message: string): string | undefined {
  if (message.startsWith("full name")) return "fullName";
  if (message.startsWith("about")) return "about";
  if (message.startsWith("time zone")) return "tz";
  return undefined;
}

// where email from agents goes, or why none can
export const EMAIL_HINT =
  "Agents may email you about chats and runs you can open, and your automations when they need attention.";

export function emailSectionText(
  user: Pick<Profile, "email" | "emailPlaceholder">,
): string {
  return user.emailPlaceholder
    ? "Your account has no real email. Ask an admin to set one."
    : `Sent to ${user.email}.`;
}
