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
