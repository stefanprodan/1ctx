// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  type CreateKnowledgeFileRequest,
  type RenameKnowledgeFileRequest,
  type ReplaceKnowledgeFileRequest,
  SEARCH_MAX,
  SEARCH_MIN,
} from "../../shared/api/knowledge.ts";
import { textFromString } from "../../shared/knowledge.ts";
import {
  isKnowledgeName,
  MAX_KNOWLEDGE_NAME,
  MAX_KNOWLEDGE_SEGMENTS,
} from "../../shared/words.ts";
import { fields, queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export function parseId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-z]{12}$/.test(value)) {
    throw new BadRequest(`${name} must be an id`);
  }
  return value;
}

export function parseName(value: unknown): string {
  if (!isKnowledgeName(value)) {
    throw new BadRequest(
      `name must be 1 to ${MAX_KNOWLEDGE_SEGMENTS} path segments of letters, digits, dots, dashes or underscores, at most 80 characters each and ${MAX_KNOWLEDGE_NAME} total, never . or ..`,
    );
  }
  return value;
}

export function parseText(value: unknown): string {
  if (typeof value !== "string") throw new BadRequest("text must be a string");
  try {
    return textFromString(value);
  } catch {
    throw new BadRequest("not a text file");
  }
}

export function parseCreate(body: unknown): CreateKnowledgeFileRequest {
  const value = fields(body, ["name", "text"]);
  return { name: parseName(value.name), text: parseText(value.text) };
}

function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest("revision must be a positive integer");
  }
  return value;
}

export function parseReplace(body: unknown): ReplaceKnowledgeFileRequest {
  const value = fields(body, ["text", "revision"]);
  return {
    text: parseText(value.text),
    revision: parseRevision(value.revision),
  };
}

export function parseRename(body: unknown): RenameKnowledgeFileRequest {
  const value = fields(body, ["name", "revision"]);
  return {
    name: parseName(value.name),
    revision: parseRevision(value.revision),
  };
}

export type SearchQuery = { q: string; after: string | null };

export function parseSearch(url: URL): SearchQuery {
  const get = queryParams(url, ["q", "after"]);
  const raw = get("q");
  if (raw === null) throw new BadRequest("q must appear once");
  const q = raw.trim();
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) {
    throw new BadRequest(`q must be ${SEARCH_MIN} to ${SEARCH_MAX} characters`);
  }
  // matches are per line, so a break could never match
  if (/[\r\n]/.test(q)) {
    throw new BadRequest("q must be one line of text");
  }
  const after = get("after");
  if (after === null) return { q, after: null };
  if (!isKnowledgeName(after)) {
    throw new BadRequest("after must be a file name");
  }
  return { q, after };
}
