// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the skill routes, all for admins.

import type { IndexEntry, SkillSummary } from "../contracts/skill.ts";

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
