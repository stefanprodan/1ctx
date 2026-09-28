// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words and checks of Access › Projects, New project and a
// project's page.

import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../shared/contracts/project.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import { RESERVED_PROJECT_NAMES } from "../../../shared/words.ts";
import { plural, pluralCommas } from "../../lib/format.ts";
import type { FinderOption } from "../../ui/Finder.tsx";

export const DESCRIPTION_PLACEHOLDER =
  "What agents should know about this project";

// a team project always says what it is for, on New project and its page
export function descriptionProblem(value: string): string | null {
  return value.trim() === "" ? "Describe the project" : null;
}

// the line under the row's name: "3 members"
export function countLine(project: ProjectSummary): string {
  return pluralCommas(project.memberCount, "member", "members");
}

// a name another team project holds, or one reserved for the personal
export function nameTaken(
  projects: readonly ProjectSummary[],
  name: string,
  exceptId?: string,
): boolean {
  return (
    RESERVED_PROJECT_NAMES.includes(name) ||
    projects.some((p) => p.name === name && p.id !== exceptId)
  );
}

// Delete's line: what goes with the project
export function deleteLine(
  project: Pick<ProjectDetail, "chats" | "knowledge">,
): string {
  const counted = [
    project.chats > 0 ? plural(project.chats, "chat") : "",
    project.knowledge.files > 0
      ? plural(project.knowledge.files, "knowledge file")
      : "",
  ].filter((part) => part !== "");
  return `Deletes its ${[...counted, "scheduled tasks and memory"].join(
    ", ",
  )}. This cannot be undone.`;
}

// Add member: the users not drafted in, by full name
export function memberOptions(
  users: readonly UserAccount[],
  ids: readonly string[],
): FinderOption[] {
  return users
    .filter((u) => !ids.includes(u.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((u) => ({
      value: u.id,
      label: u.fullName,
      sub: u.disabled ? `@${u.username} · disabled` : `@${u.username}`,
      keywords: `${u.username} ${u.email}`,
    }));
}

// which field a refusal of the project routes names; the rest, a running
// chat or a member already there, is the card's
export function projectFieldOf(message: string): string | undefined {
  if (message.startsWith("name")) return "name";
  if (message.startsWith("description")) return "description";
  return undefined;
}
