// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import { checkEntries, MEMORY_CHARS, normalize } from "../../shared/memory.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const MAX_MEMORY_BODY = MEMORY_CHARS * 8;

function revision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequest("revision must be a non-negative integer");
  }
  return value as number;
}

export function parseSaveMemory(body: unknown): SaveMemoryRequest {
  const value = fields(body, ["entries", "revision"]);
  if (!Array.isArray(value.entries)) {
    throw new BadRequest("entries must be a list of topics and text");
  }
  const entries = normalize(
    value.entries.map((raw: unknown, index): MemoryEntry => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new BadRequest(`entry ${index + 1} must have a topic and text`);
      }
      const entry = fields(raw, ["topic", "text"]);
      if (typeof entry.topic !== "string") {
        throw new BadRequest(`the topic of entry ${index + 1} must be text`);
      }
      if (typeof entry.text !== "string") {
        throw new BadRequest(
          `the text of ${entry.topic.trim() || `entry ${index + 1}`} must be text`,
        );
      }
      return { topic: entry.topic, text: entry.text };
    }),
  );
  const problem = checkEntries(entries);
  if (problem !== null) throw new BadRequest(`entries: ${problem}`);
  return { entries, revision: revision(value.revision) };
}

export function parseUndoMemory(body: unknown): UndoMemoryRequest {
  const value = fields(body, ["revision"]);
  return { revision: revision(value.revision) };
}
