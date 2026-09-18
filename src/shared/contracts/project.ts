// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The project as the wire exposes it: the row in the rail and the list,
// and the page with its members.

import type { ProjectKind } from "../words.ts";
import type { KnowledgeCounts } from "./knowledge.ts";
import type { UserSummary } from "./user.ts";

export type ProjectSummary = {
  id: string;
  kind: ProjectKind;
  name: string;
  createdAt: number;
  // the membership rows, so a list row counts people without the detail
  memberCount: number;
};

export type ProjectDetail = ProjectSummary & {
  // empty for none
  description: string;
  members: UserSummary[];
  chats: number;
  // the knowledge base, for the aside and the tab's count
  knowledge: KnowledgeCounts;
};
