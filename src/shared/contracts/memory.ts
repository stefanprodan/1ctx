// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A memory note as the wire exposes it: the project's, or one of its
// automation's. A missing row reads as an empty note with no previous
// version. The revision counts the writes; a save names the revision
// it read.

import type { UserSummary } from "./user.ts";

export type MemoryEntry = { topic: string; text: string };

export type Memory = {
  projectId: string;
  // null for the project's own note
  automationId: string | null;
  entries: MemoryEntry[];
  // the version before the last write; null before the first
  previous: MemoryEntry[] | null;
  chars: number;
  limit: number;
  revision: number;
  // null before the first write
  updatedAt: number | null;
  // a user for a hand edit or an undo, null for a run
  updatedBy: UserSummary | null;
  // the run that last committed, null for a hand edit; the automation
  // is null once deleted
  run: {
    sessionId: string;
    automationId: string | null;
    automationName: string | null;
  } | null;
};
