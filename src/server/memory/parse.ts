// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import { checkEntries, MEMORY_CHARS, normalize } from "../../shared/memory.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_MEMORY_BODY = MEMORY_CHARS * 4;

function revision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequest("revision must be a non-negative integer");
  }
  return value as number;
}

export function parseSaveMemory(body: unknown): SaveMemoryRequest {
  const value = fields(body, ["entries", "revision"]);
  if (!Array.isArray(value.entries)) {
    throw new BadRequest("entries must be a list of text");
  }
  if (!value.entries.every((entry) => typeof entry === "string")) {
    throw new BadRequest("entries must be a list of text");
  }
  const entries = normalize(value.entries as string[]);
  const problem = checkEntries(entries);
  if (problem !== null) throw new BadRequest(`entries: ${problem}`);
  return { entries, revision: revision(value.revision) };
}

export function parseUndoMemory(body: unknown): UndoMemoryRequest {
  const value = fields(body, ["revision"]);
  return { revision: revision(value.revision) };
}
