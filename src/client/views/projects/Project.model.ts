// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project's kind, and its tabs.

import type { ProjectKind } from "../../../shared/words.ts";
import type { Tab } from "../../ui/Tabs.tsx";

// Feed carries no count: the list is capped, so a number would lie
// on a busy project
export function tabsOf(id: string, members: number | null): Tab[] {
  return [
    { label: "Feed", href: `/projects/${id}` },
    { label: "Members", href: `/projects/${id}/members`, count: members },
  ];
}

export function kindLine(kind: ProjectKind): string {
  return kind === "personal" ? "personal" : "team";
}

// the line under a project's name
export function kindText(kind: ProjectKind): string {
  return kind === "personal"
    ? "Your personal project. What is in it is yours alone."
    : "A team project. Every member sees everything in it.";
}
