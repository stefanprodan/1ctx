// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A skill as the wire exposes it: a SKILL.md fetched from a URL and
// kept as rows, its frontmatter fields, where it came from, the files
// beside it, what the last refresh changed, and the agents that carry
// it. The body travels on its own route, so a list of twenty stays
// light.

import type { SkillSource } from "../words.ts";

export type SkillFile = { path: string; bytes: number };
export type SkillDropped = { path: string; reason: string };

// what a refresh found different, from the digests
export type SkillChange = {
  at: number;
  body: boolean;
  description: boolean;
  // the other frontmatter fields that moved: license, compatibility,
  // metadata, allowedTools
  fields: string[];
  files: { added: string[]; removed: string[]; changed: string[] };
};

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  // stored and shown, never enforced
  allowedTools: string;
  sourceKind: SkillSource;
  // as pasted
  sourceUrl: string;
  // the path in an archive, the entry in an index, else ""
  sourceSelect: string;
  // the index's digest, "" unless from an index
  sourceDigest: string;
  // SHA-256 over the paths and the file digests, SKILL.md included
  digest: string;
  bodyBytes: number;
  files: SkillFile[];
  dropped: SkillDropped[];
  // over the cap the list says how many more
  droppedMore: number;
  fetchedAt: number;
  lastChange: SkillChange | null;
  refreshError: string | null;
  refreshFailedAt: number | null;
  // the names of the agents that carry it
  agents: string[];
  createdAt: number;
};

// one entry of a site's discovery index, its URL resolved
export type IndexEntry = {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: string;
  digest: string;
};

// a skill as the send's snapshot holds it: the catalog block is built
// from these, and the two tools read by id
export type OfferedSkill = {
  id: string;
  name: string;
  description: string;
  hasFiles: boolean;
};
