// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project, its tabs, and the check of its name.

import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../shared/contracts/project.ts";
import type { ProjectKind } from "../../../shared/words.ts";
import { matches } from "../../lib/search.ts";
import type { Tab } from "../../ui/Tabs.tsx";

// the Projects card: the personal project first, then the teams, those
// whose name holds the search, in any case
export function listedProjects<T extends Pick<ProjectSummary, "kind" | "name">>(
  list: readonly T[],
  q: string,
): T[] {
  return [
    ...list.filter((p) => p.kind === "personal"),
    ...list.filter((p) => p.kind === "team"),
  ].filter((p) => matches(q, [p.name]));
}

// "1 user", "2 agents"
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// what the tabs count; null while it is not known yet
export type TabCounts = {
  automations: number | null;
  // the files of the project's knowledge base
  knowledge: number | null;
  // the people and the agents a team tab lists
  members: number | null;
  agents: number | null;
};

const NO_COUNTS: TabCounts = {
  automations: null,
  knowledge: null,
  members: null,
  agents: null,
};

const counted = (n: number | null) => (n === null ? {} : { count: n });

// every project has automations; a team's people are its Members, and
// a personal project has one person, who describes it in Settings.
// Members counts the users and the agents the tab lists
export function tabsOf(
  id: string,
  kind: ProjectKind,
  counts: TabCounts = NO_COUNTS,
): Tab[] {
  const members =
    counts.members === null || counts.agents === null
      ? null
      : counts.members + counts.agents;
  return [
    { label: "Feed", href: `/projects/${id}` },
    {
      label: "Automations",
      href: `/projects/${id}/automations`,
      ...counted(counts.automations),
    },
    { label: "Memory", href: `/projects/${id}/memory` },
    {
      label: "Knowledge",
      href: `/projects/${id}/knowledge`,
      ...counted(counts.knowledge),
    },
    kind === "team"
      ? {
          label: "Members",
          href: `/projects/${id}/members`,
          ...counted(members),
        }
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
