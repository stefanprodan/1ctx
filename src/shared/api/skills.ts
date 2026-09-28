// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the skill routes, all for admins.

import type { IndexEntry, SkillSummary } from "../contracts/skill.ts";
import type { Windowed } from "./admin.ts";

// GET /api/skills
export type SkillsResponse = { skills: SkillSummary[] };

// GET /api/skills/:id, POST /api/skills and POST /api/skills/:id/refresh
// answer the row with its body
export type SkillResponse = { skill: SkillSummary; body: string };

// POST /api/skills: a URL with the path inside an archive, or an index
// URL with the entry's name and the digest discovery answered
export type AddSkillRequest =
  | { url: string; path?: string }
  | { url: string; name: string; digest: string };

// POST /api/skills/discover: a site or an index URL
export type DiscoverRequest = { url: string };
export type DiscoverResponse = { url: string; entries: IndexEntry[] };

// GET /api/skills/:id/file?path=
export type SkillFileResponse = {
  path: string;
  content: string;
  bytes: number;
};

export type SkillCounts = { loads: number; reads: number; failed: number };
// the files most read first
export type SkillUsage = SkillCounts & {
  files: { path: string; reads: number }[];
};
// every skill by name, the most loaded first, a deleted skill's under
// its name
export type SkillLoads = SkillCounts & {
  skills: ({ name: string } & SkillUsage)[];
};

// GET /api/skills/:id/usage and /api/usage/skills: the last 30 days
export type SkillUsageResponse = Windowed<SkillUsage>;
export type SkillsUsageResponse = Windowed<
  SkillCounts & { skills: ({ name: string } & SkillCounts)[] }
>;
