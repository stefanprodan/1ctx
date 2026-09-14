// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words and checks of the admin projects page.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import { longDate } from "../../lib/format.ts";

export function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

// the line under the row's name: "3 members"
export function countLine(project: ProjectSummary): string {
  return plural(project.memberCount, "member");
}

// the row's right side: "since 14 September 2026"
export function sinceLine(project: ProjectSummary): string {
  return `since ${longDate(project.createdAt)}`;
}

// the row's avatar: the first letters of the name's first two words, or
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

// the people the picker offers: every user not in the project whose
// full name, username or email holds the query, by full name
export function candidates(
  users: UserAccount[],
  memberIds: ReadonlySet<string>,
  query: string,
): UserAccount[] {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return users
    .filter((user) => !memberIds.has(user.id))
    .filter(
      (user) =>
        q === "" ||
        user.fullName.toLowerCase().includes(q) ||
        user.username.includes(q) ||
        user.email.includes(q),
    )
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// the arrow keys walk the list and wrap at either end
export function step(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}

// the faint word at a candidate's right
export function candidateNote(user: UserAccount): string {
  if (user.disabled) return "disabled";
  return user.role === "admin" ? "admin" : "";
}
