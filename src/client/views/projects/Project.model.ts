// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project's kind, and its tabs.

import type { ProjectKind } from "../../../shared/words.ts";
import type { Tab } from "../../ui/Tabs.tsx";

// "1 user", "2 agents"
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function tabsOf(id: string): Tab[] {
  return [
    { label: "Feed", href: `/projects/${id}` },
    { label: "Members", href: `/projects/${id}/members` },
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
