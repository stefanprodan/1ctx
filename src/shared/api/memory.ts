// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the memory routes, the project's
// (/api/projects/:id/memory) and an automation's
// (/api/automations/:id/memory). Anyone who sees the project reads,
// saves and undoes.

import type { Memory, MemoryEntry } from "../contracts/memory.ts";

// GET, PUT and POST .../undo answer the note
export type MemoryResponse = { memory: Memory };

// PUT: the entries as they should be, and the revision read; a stale
// revision is a 409
export type SaveMemoryRequest = { entries: MemoryEntry[]; revision: number };

// POST .../undo: the revision read; stale, or nothing to undo, is a 409
export type UndoMemoryRequest = { revision: number };
