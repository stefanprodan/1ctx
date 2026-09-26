// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words and checks of the admin projects page.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import { pluralCommas } from "../../lib/format.ts";
import { stepHighlight } from "../../ui/Select.model.ts";

// the line under the row's name: "3 members"
export function countLine(project: ProjectSummary): string {
  return pluralCommas(project.memberCount, "member", "members");
}

export function deleteLabel(chats: number): string {
  return chats === 0
    ? "Delete"
    : `Delete with ${pluralCommas(chats, "chat", "chats")}`;
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

// the faint word at a candidate's right
export function candidateNote(user: UserAccount): string {
  if (user.disabled) return "disabled";
  return user.role === "admin" ? "admin" : "";
}

// which field a refusal of the project routes names; the rest, a running
// chat or a member already there, is the form's
export function projectFieldOf(message: string): string | undefined {
  if (message.startsWith("name")) return "name";
  if (message.startsWith("description")) return "description";
  return undefined;
}

// an arrow in the member list; an empty list keeps 0, so the refilled
// list starts at the top
export function stepMember(active: number, length: number, by: 1 | -1) {
  return Math.max(0, stepHighlight(active, length, by));
}
