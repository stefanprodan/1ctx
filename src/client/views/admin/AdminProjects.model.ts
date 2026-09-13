// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words and checks of the admin projects page.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { isName, MAX_NAME, MIN_NAME } from "../../../shared/words.ts";
import { longDate } from "../../lib/format.ts";

export function nameProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter a name";
  if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) {
    return `${MIN_NAME} to ${MAX_NAME} characters`;
  }
  if (!isName(trimmed)) return "Lowercase letters, digits and dashes";
  return null;
}

export function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

// the row's right side: "3 members · since 14 September 2026"
export function metaLine(project: ProjectSummary): string {
  return `${plural(project.memberCount, "member")} · since ${longDate(
    project.createdAt,
  )}`;
}

// the row's tile: the first letters of the name's first two words, or
// its first two letters. "on-call" is "OC", "research" is "RE"
export function mark(name: string): string {
  const words = name.split("-").filter(Boolean);
  const letters =
    words.length >= 2 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

export function deleteLabel(chats: number): string {
  return chats === 0 ? "Delete" : `Delete with ${plural(chats, "chat")}`;
}
