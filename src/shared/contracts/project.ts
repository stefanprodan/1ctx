// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The project as the wire exposes it: the row in the rail and the list,
// and the page with its members.

import type { ProjectKind } from "../words.ts";
import type { UserSummary } from "./user.ts";

export type ProjectSummary = {
  id: string;
  kind: ProjectKind;
  // the personal project is named after its user
  name: string;
};

export type ProjectDetail = ProjectSummary & {
  createdAt: number;
  members: UserSummary[];
};
