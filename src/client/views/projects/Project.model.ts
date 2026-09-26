// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project, its tabs, and the check of its name.

import type { KnowledgeFile } from "../../../shared/contracts/knowledge.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../shared/contracts/project.ts";
import { LATEST_FILES } from "../../../shared/knowledge.ts";
import type { ProjectKind } from "../../../shared/words.ts";
import { pluralCommas } from "../../lib/format.ts";
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

// what the tabs count; null while it is not known yet
type TabCounts = {
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

// the counts once every one the tabs show is known, else none: they
// arrive from separate loads, and one at a time would move the row
// with each
export function settledCounts(kind: ProjectKind, counts: TabCounts): TabCounts {
  const shown = [
    counts.automations,
    counts.knowledge,
    ...(kind === "team" ? [counts.members, counts.agents] : []),
  ];
  return shown.every((n) => n !== null) ? counts : NO_COUNTS;
}

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
    : pluralCommas(project.memberCount, "member", "members");
}

// the About card's first line; a team without a description has none
export function aboutLine(
  project: Pick<ProjectDetail, "kind" | "description">,
): string | null {
  if (project.description !== "") return project.description;
  return project.kind === "personal" ? "Your personal project" : null;
}

// the aside's latest files: from the list once it is held, since frames
// keep it fresh, else what the project row said
export function latestFiles(
  held: readonly KnowledgeFile[] | null,
  row: readonly KnowledgeFile[],
): KnowledgeFile[] {
  if (held === null) return [...row];
  return [...held]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LATEST_FILES);
}
