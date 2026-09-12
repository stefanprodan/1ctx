// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Who may see a project. A personal project is its owner's alone, an
// admin included; a team project is open to its members and to every
// admin. Pure, so the rule is tested on rows without a database.

import type { Principal } from "../lib/http.ts";
import type { ProjectRow } from "./store.ts";

export function visible(
  project: ProjectRow,
  principal: Pick<Principal, "userId" | "role">,
  member: boolean,
): boolean {
  if (project.kind === "personal") return project.ownerId === principal.userId;
  return member || principal.role === "admin";
}
