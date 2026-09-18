// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateKnowledgeFileRequest,
  ReplaceKnowledgeFileRequest,
} from "../../shared/api/knowledge.ts";
import { isKnowledgeName } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { textFromString } from "./text.ts";

export function parseName(value: unknown): string {
  if (!isKnowledgeName(value)) {
    throw new BadRequest(
      "name must be 1 to 8 path segments of letters, digits, dots, dashes or underscores, at most 80 characters each and 200 total, never . or ..",
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

export function parseReplace(body: unknown): ReplaceKnowledgeFileRequest {
  const value = fields(body, ["text", "revision"]);
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new BadRequest("revision must be a positive integer");
  }
  return { text: parseText(value.text), revision: value.revision };
}
