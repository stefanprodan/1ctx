// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project, its tabs, and the check of its name.

import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import {
  isName,
  MAX_NAME,
  MIN_NAME,
  type ProjectKind,
} from "../../../shared/words.ts";
import type { Tab } from "../../ui/Tabs.tsx";

// "1 user", "2 agents"
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// a team's people are its Members; a personal project has one person,
// who names and describes it in Settings
export function tabsOf(id: string, kind: ProjectKind): Tab[] {
  return [
    { label: "Feed", href: `/projects/${id}` },
    kind === "team"
      ? { label: "Members", href: `/projects/${id}/members` }
      : { label: "Settings", href: `/projects/${id}/settings` },
  ];
}

export function kindLine(kind: ProjectKind): string {
  return kind === "personal" ? "personal" : "team";
}

// the About card's first line; a team without a description has none
export function aboutLine(
  project: Pick<ProjectDetail, "kind" | "description">,
): string | null {
  if (project.description !== "") return project.description;
  return project.kind === "personal" ? "Your personal project" : null;
}

export function nameProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter a name";
  if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) {
    return `${MIN_NAME} to ${MAX_NAME} characters`;
  }
  if (!isName(trimmed)) return "Lowercase letters, digits and dashes";
  return null;
}
