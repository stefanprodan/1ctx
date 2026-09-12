// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words for a project's kind.

import type { ProjectKind } from "../../../shared/words.ts";

export function kindLine(kind: ProjectKind): string {
  return kind === "personal" ? "personal" : "team";
}

// the line under a project's name
export function kindText(kind: ProjectKind): string {
  return kind === "personal"
    ? "Your personal project. What is in it is yours alone."
    : "A team project. Every member sees everything in it.";
}
