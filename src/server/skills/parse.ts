// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AddSkillRequest,
  DiscoverRequest,
} from "../../shared/api/skills.ts";
import { sourceKind } from "../../shared/skills.ts";
import { isSkillName } from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { MAX_SKILL_URL } from "./limits.ts";
import { validPath } from "./source.ts";

function urlOf(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequest("url must be a URL");
  }
  if (value.length > MAX_SKILL_URL) throw new BadRequest("url is too long");
  if (sourceKind(value) === null)
    throw new BadRequest("url must be http or https");
  return value;
}

export function parseDiscover(body: unknown): DiscoverRequest {
  const b = fields(body, ["url"]);
  const url = urlOf(b.url);
  if (sourceKind(url) !== "index") {
    throw new BadRequest("url is not a skills index");
  }
  return { url };
}

export function parseAdd(body: unknown): AddSkillRequest {
  const b = fields(body, ["url", "path", "name", "digest"]);
  const url = urlOf(b.url);
  const kind = sourceKind(url)!;
  const indexFields = b.name !== undefined || b.digest !== undefined;
  if (indexFields) {
    if (kind !== "index" || b.path !== undefined) {
      throw new BadRequest("index fields do not match the URL");
    }
    if (!isSkillName(b.name)) throw new BadRequest("name is invalid");
    if (
      typeof b.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(b.digest)
    ) {
      throw new BadRequest("digest is invalid");
    }
    return { url, name: b.name, digest: b.digest };
  }
  if (kind === "index") throw new BadRequest("choose a skill from the index");
  if (b.path !== undefined) {
    if (kind !== "archive") throw new BadRequest("path is only for an archive");
    if (typeof b.path !== "string" || (b.path !== "" && !validPath(b.path))) {
      throw new BadRequest("path is invalid");
    }
    return { url, path: b.path };
  }
  return { url };
}

export function parseFile(url: URL): string {
  for (const key of url.searchParams.keys()) {
    if (key !== "path") throw new BadRequest(`unknown query ${key}`);
  }
  const path = url.searchParams.get("path");
  if (path === null || !validPath(path))
    throw new BadRequest("path is invalid");
  return path;
}
