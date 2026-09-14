// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { IndexEntry } from "../../shared/contracts/skill.ts";
import { codeloadUrl, sourceForm } from "../../shared/skills.ts";
import { isSkillName, type SkillSource } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import { MAX_INDEX_BYTES, MAX_INDEX_ENTRIES } from "./limits.ts";

export type ResolvedSource = {
  kind: SkillSource;
  sourceUrl: string;
  fetchUrl: string;
  select: string;
};

export type Picked = {
  skillMd: Uint8Array;
  files: Map<string, Uint8Array>;
};

// GNU tar commonly prefixes every member with "./". Empty and ".."
// segments stay in place so validation still refuses unsafe paths.
export function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== ".")
    .join("/");
}

export function validPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  for (const char of path) {
    const code = char.codePointAt(0)!;
    if (
      char === "<" ||
      char === ">" ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return false;
    }
  }
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function resolve(url: string, select = ""): ResolvedSource {
  const form = sourceForm(url);
  if (form === null) throw new BadRequest("URL must be http or https");
  if (form.kind === "github") {
    if (form.path === "") throw new BadRequest("GitHub path is empty");
    return {
      kind: "github",
      sourceUrl: url,
      fetchUrl: codeloadUrl(form),
      select: form.path,
    };
  }
  return {
    kind: form.kind,
    sourceUrl: url,
    fetchUrl: form.url,
    select,
  };
}

function absoluteUrl(value: unknown, base: string): string {
  if (typeof value !== "string") throw new BadRequest("index URL is missing");
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new BadRequest("index URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new BadRequest("index URL must be http or https");
  }
  return url.href;
}

export function parseIndex(text: string, indexUrl: string): IndexEntry[] {
  if (new TextEncoder().encode(text).byteLength > MAX_INDEX_BYTES) {
    throw new BadRequest("the index is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest("the index is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest("the index must be an object");
  }
  const skills = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(skills)) throw new BadRequest("the index has no skills");
  if (skills.length > MAX_INDEX_ENTRIES) {
    throw new BadRequest("the index has too many skills");
  }
  return skills.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new BadRequest(`index entry ${index + 1} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (!isSkillName(entry.name)) {
      throw new BadRequest(`index entry ${index + 1} has an invalid name`);
    }
    if (entry.type !== "skill-md" && entry.type !== "archive") {
      throw new BadRequest(`index entry ${entry.name} has an invalid type`);
    }
    if (typeof entry.description !== "string") {
      throw new BadRequest(`index entry ${entry.name} has no description`);
    }
    if (
      typeof entry.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.digest)
    ) {
      throw new BadRequest(`index entry ${entry.name} has an invalid digest`);
    }
    return {
      name: entry.name,
      type: entry.type,
      description: entry.description,
      url: absoluteUrl(entry.url, indexUrl),
      digest: entry.digest,
    };
  });
}

export function pick(files: Map<string, Uint8Array>, path: string): Picked {
  // the archive member count is bounded in fetch.ts before pick runs;
  // here the keys are normalized and their paths validated
  const normalized = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    const clean = normalizePath(name);
    if (!validPath(clean)) throw new BadRequest(`invalid archive path ${name}`);
    normalized.set(clean, bytes);
  }
  const want = path === "" ? "" : normalizePath(path);
  if (want !== "" && !validPath(want)) throw new BadRequest("path is invalid");

  const skillPaths = [...normalized.keys()].filter((name) => {
    if (want === "") {
      const parts = name.split("/");
      return (
        name === "SKILL.md" || (parts.length === 2 && parts[1] === "SKILL.md")
      );
    }
    const target = `${want}/SKILL.md`;
    const parts = name.split("/");
    return name === target || parts.slice(1).join("/") === target;
  });
  if (skillPaths.length === 0) throw new BadRequest("no SKILL.md at that path");
  if (skillPaths.length > 1) {
    throw new BadRequest(`more than one SKILL.md: ${skillPaths.join(", ")}`);
  }
  const skillPath = skillPaths[0]!;
  const prefix = skillPath.slice(0, -"SKILL.md".length);
  const picked = new Map<string, Uint8Array>();
  for (const [name, bytes] of normalized) {
    if (!name.startsWith(prefix) || name === skillPath) continue;
    const relative = name.slice(prefix.length);
    if (relative !== "") picked.set(relative, bytes);
  }
  return { skillMd: normalized.get(skillPath)!, files: picked };
}
