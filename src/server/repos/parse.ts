// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The repository request parsers: a new repository and a change to
// one. The rules that need the project or a credential are in check.ts.

import type {
  CreateRepoRequest,
  PatchRepoRequest,
} from "../../shared/api/repos.ts";
import {
  isRepoKind,
  MAX_REPO_IGNORE_BYTES,
  MAX_REPO_IGNORE_LINES,
  REPO_KINDS,
} from "../../shared/contracts/repo.ts";
import {
  isName,
  MAX_NAME,
  MIN_NAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { type Checked, checkRef, normalizeUrl } from "./adapters.ts";

// a row id, as lib/ids.ts makes them
const ID = /^[0-9a-z]{1,32}$/;

function checked<T>(result: Checked<T>): T {
  if (!result.ok) throw new BadRequest(result.error);
  return result.value;
}

export function parseRepoName(value: unknown): string {
  if (!isName(value)) {
    throw new BadRequest(
      `name must be ${MIN_NAME} to ${MAX_NAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

// the normalized form; the host's kind is the caller's to apply
export const parseRepoUrl = (value: unknown) =>
  checked(normalizeUrl(value)).url;

export const parseRef = (value: unknown) => checked(checkRef(value));

export function parseKind(value: unknown) {
  if (!isRepoKind(value)) {
    throw new BadRequest(`kind must be ${REPO_KINDS.join(" or ")}`);
  }
  return value;
}

export function parseCredentialId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ID.test(value)) {
    throw new BadRequest("credentialId must be a credential id or null");
  }
  return value;
}

// the line-by-line syntax check, until the ignore matcher lands
function checkIgnoreSyntax(text: string): Checked<string> {
  return { ok: true, value: text };
}

// .gitignore text: at most MAX_REPO_IGNORE_LINES lines and
// MAX_REPO_IGNORE_BYTES bytes, each line one the matcher reads
export function parseIgnoreText(value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequest("ignore must be text");
  }
  if (new TextEncoder().encode(value).length > MAX_REPO_IGNORE_BYTES) {
    throw new BadRequest(
      `ignore must be at most ${MAX_REPO_IGNORE_BYTES / 1024} KiB`,
    );
  }
  if (value.replace(/\n$/, "").split("\n").length > MAX_REPO_IGNORE_LINES) {
    throw new BadRequest(
      `ignore must be at most ${MAX_REPO_IGNORE_LINES} lines`,
    );
  }
  return checked(checkIgnoreSyntax(value));
}

const FIELDS = ["url", "name", "kind", "ref", "credentialId", "ignore"];

const parsers = {
  url: parseRepoUrl,
  name: parseRepoName,
  kind: parseKind,
  ref: parseRef,
  credentialId: parseCredentialId,
  ignore: parseIgnoreText,
};

function parsed(b: Record<string, unknown>): PatchRepoRequest {
  const out: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(parsers)) {
    if (Object.hasOwn(b, key)) out[key] = parse(b[key]);
  }
  return out as PatchRepoRequest;
}

export function parseCreateRepo(body: unknown): CreateRepoRequest {
  const b = fields(body, FIELDS);
  if (!Object.hasOwn(b, "url")) throw new BadRequest("url is required");
  return parsed(b) as CreateRepoRequest;
}

export function parsePatchRepo(body: unknown): PatchRepoRequest {
  return parsed(fields(body, FIELDS));
}
