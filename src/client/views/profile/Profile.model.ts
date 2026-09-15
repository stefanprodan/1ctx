// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the profile forms check before they call: the same rules the
// server applies, so a slip is caught without a round trip, and the
// server's word is still the last.

import {
  isFullName,
  MAX_ABOUT,
  MAX_FULL_NAME,
  MIN_PASSWORD,
} from "../../../shared/words.ts";
import type { Problem } from "../../lib/save.ts";

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

// which password box a server refusal names; a rate limit is the form's
export function passwordFieldOf(message: string): string | undefined {
  if (message.includes("current password")) return "current";
  if (message.startsWith("new password")) return "next";
  return undefined;
}

// the password checks pinned to the box to fix
export function passwordFieldProblem(
  current: string,
  next: string,
  again: string,
): Problem | null {
  const error = passwordProblem(current, next, again);
  if (error === null) return null;
  if (error.includes("current password")) return { error, field: "current" };
  if (error.includes("differ")) return { error, field: "again" };
  return { error, field: "next" };
}

export function passwordProblem(
  current: string,
  next: string,
  again: string,
): string | null {
  if (current === "") return "Enter your current password";
  if (next.length < MIN_PASSWORD)
    return `The new password needs at least ${MIN_PASSWORD} characters`;
  if (next === current)
    return "The new password is the same as the current one";
  if (again !== next) return "The two new passwords differ";
  return null;
}
