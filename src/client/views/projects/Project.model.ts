// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project, its tabs, and the check of its name.

import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../shared/contracts/project.ts";
import type { ProjectKind } from "../../../shared/words.ts";
import type { Tab } from "../../ui/Tabs.tsx";

// "1 user", "2 agents"
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// every project has automations; a team's people are its Members, and
// a personal project has one person, who describes it in Settings
export function tabsOf(id: string, kind: ProjectKind): Tab[] {
  return [
    { label: "Feed", href: `/projects/${id}` },
    { label: "Automations", href: `/projects/${id}/automations` },
    kind === "team"
      ? { label: "Members", href: `/projects/${id}/members` }
      : { label: "Settings", href: `/projects/${id}/settings` },
  ];
}

// the line under a project's name on the Projects page
export function peopleLine(
  project: Pick<ProjectSummary, "kind" | "memberCount">,
): string {
  return project.kind === "personal"
    ? "only you"
    : plural(project.memberCount, "member");
}

// the About card's first line; a team without a description has none
export function aboutLine(
  project: Pick<ProjectDetail, "kind" | "description">,
): string | null {
  if (project.description !== "") return project.description;
  return project.kind === "personal" ? "Your personal project" : null;
}

// the field shapes the name as it is typed and the server holds the
// rule, so the one slip worth catching here is an empty field
export function nameProblem(value: string): string | null {
  return value.trim() === "" ? "Enter a name" : null;
}
