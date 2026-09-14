// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SkillChange,
  SkillDropped,
} from "../../shared/contracts/skill.ts";
import type { SkillSource } from "../../shared/words.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import { cleanText } from "./clean.ts";
import { type Fetched, fetchSource, fetchText } from "./fetch.ts";
import { parseSkillMd } from "./frontmatter.ts";
import {
  MAX_BODY_CHARS,
  MAX_DROPPED,
  MAX_FILE_CHARS,
  MAX_FILES,
  MAX_FILES_CHARS,
  MAX_INDEX_BYTES,
} from "./limits.ts";
import { parseIndex, pick, resolve } from "./source.ts";

export type LoadedFile = { path: string; content: string; bytes: number };
export type LoadedSkill = {
  name: string;
  description: string;
  body: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string;
  sourceKind: SkillSource;
  sourceUrl: string;
  sourceSelect: string;
  sourceDigest: string;
  digest: string;
  dropped: SkillDropped[];
  droppedMore: number;
  files: LoadedFile[];
};

export type LoadSelection =
  | { path?: string }
  | { name: string; digest: string };

const byteDigest = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const textDigest = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function filesFrom(source: Map<string, Uint8Array>): {
  files: LoadedFile[];
  dropped: SkillDropped[];
  droppedMore: number;
} {
  if (source.size > MAX_FILES)
    throw new BadRequest("the skill has too many files");
  const files: LoadedFile[] = [];
  const dropped: SkillDropped[] = [];
  let droppedMore = 0;
  let total = 0;
  const drop = (path: string, reason: string) => {
    if (dropped.length < MAX_DROPPED) dropped.push({ path, reason });
    else droppedMore++;
  };
  for (const [path, bytes] of [...source].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const decoded = decode(bytes);
    if (decoded === null) {
      drop(path, "binary");
      continue;
    }
    const content = cleanText(decoded);
    if ([...content].length > MAX_FILE_CHARS) {
      drop(path, "too large");
      continue;
    }
    total += [...content].length;
    if (total > MAX_FILES_CHARS)
      throw new BadRequest("the skill files are too large");
    files.push({
      path,
      content,
      bytes: new TextEncoder().encode(content).byteLength,
    });
  }
  return { files, dropped, droppedMore };
}

// the digest is over exactly what changeOf compares: the body, the
// frontmatter fields, the kept files by path and content digest, and
// the dropped list, so "unchanged" is one byte comparison and every
// difference the digest sees is one last_change names
function digestOf(skill: {
  body: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string;
  files: LoadedFile[];
  dropped: SkillDropped[];
  droppedMore: number;
}): string {
  const files = skill.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\0${textDigest(file.content)}`);
  const dropped = skill.dropped
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((item) => `${item.path}\0${item.reason}`);
  const metadata = Object.entries(skill.metadata)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}\0${value}`);
  const shape = {
    body: skill.body,
    description: skill.description,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata,
    allowedTools: skill.allowedTools,
    files,
    dropped,
    droppedMore: skill.droppedMore,
  };
  return textDigest(JSON.stringify(shape));
}

export async function discover(
  fetcher: typeof fetch,
  url: string,
  shutdown: AbortSignal,
) {
  const source = resolve(url);
  if (source.kind !== "index")
    throw new BadRequest("URL is not a skills index");
  const fetched = await fetchText(
    fetcher,
    source.fetchUrl,
    shutdown,
    MAX_INDEX_BYTES,
  );
  return {
    url: source.fetchUrl,
    entries: parseIndex(fetched.text, source.fetchUrl),
  };
}

export async function loadSkill(
  fetcher: typeof fetch,
  url: string,
  selection: LoadSelection,
  shutdown: AbortSignal,
): Promise<LoadedSkill> {
  const selected =
    "name" in selection ? selection.name : (selection.path ?? "");
  const source = resolve(url, selected);
  let fetched: Fetched;
  let sourceDigest = "";
  if (source.kind === "index") {
    if (!("name" in selection))
      throw new BadRequest("choose a skill from the index");
    const index = await fetchText(
      fetcher,
      source.fetchUrl,
      shutdown,
      MAX_INDEX_BYTES,
    );
    const entries = parseIndex(index.text, source.fetchUrl);
    const entry = entries.find((item) => item.name === selection.name);
    if (
      entry === undefined ||
      (selection.digest !== "" && entry.digest !== selection.digest)
    ) {
      throw new Conflict("the index changed, look again");
    }
    fetched = await fetchSource(fetcher, entry.url, shutdown);
    const actual = `sha256:${byteDigest(fetched.bytes)}`;
    if (actual !== entry.digest) {
      throw new BadRequest(`digest ${actual} does not match ${entry.digest}`);
    }
    if (entry.type === "skill-md" && fetched.kind !== "text") {
      throw new BadRequest("the index entry is not a SKILL.md");
    }
    if (entry.type === "archive" && fetched.kind !== "archive") {
      throw new BadRequest("the index entry is not an archive");
    }
    sourceDigest = entry.digest;
  } else {
    fetched = await fetchSource(fetcher, source.fetchUrl, shutdown);
  }

  // an archive from an index holds the skill at its root, so it is
  // picked with an empty path; source.select is the index entry name,
  // not a path inside the archive
  const pickPath = source.kind === "index" ? "" : source.select;
  const picked =
    fetched.kind === "text"
      ? { skillMd: fetched.bytes, files: new Map<string, Uint8Array>() }
      : pick(fetched.files, pickPath);
  const skillText = decode(picked.skillMd);
  if (skillText === null) throw new BadRequest("SKILL.md is not UTF-8 text");
  const parsed = parseSkillMd(skillText);
  const body = cleanText(parsed.body);
  if ([...body].length > MAX_BODY_CHARS)
    throw new BadRequest("the skill body is too large");
  const kept = filesFrom(picked.files);
  const cleaned = {
    ...parsed,
    name: cleanText(parsed.name),
    description: cleanText(parsed.description),
    body,
    license: cleanText(parsed.license),
    compatibility: cleanText(parsed.compatibility),
    metadata: Object.fromEntries(
      Object.entries(parsed.metadata).map(([key, value]) => [
        cleanText(key),
        cleanText(value),
      ]),
    ),
    allowedTools: cleanText(parsed.allowedTools),
    files: kept.files,
  };
  return {
    ...cleaned,
    sourceKind: source.kind,
    sourceUrl: source.sourceUrl,
    sourceSelect: source.select,
    sourceDigest,
    digest: digestOf({
      body: cleaned.body,
      description: cleaned.description,
      license: cleaned.license,
      compatibility: cleaned.compatibility,
      metadata: cleaned.metadata,
      allowedTools: cleaned.allowedTools,
      files: kept.files,
      dropped: kept.dropped,
      droppedMore: kept.droppedMore,
    }),
    dropped: kept.dropped,
    droppedMore: kept.droppedMore,
  };
}

export function changeOf(
  before: LoadedSkill,
  after: LoadedSkill,
  now: number,
): SkillChange | null {
  const fields: string[] = [];
  if (before.license !== after.license) fields.push("license");
  if (before.compatibility !== after.compatibility)
    fields.push("compatibility");
  const metadataKey = (skill: LoadedSkill) =>
    JSON.stringify(
      Object.entries(skill.metadata).sort(([a], [b]) => a.localeCompare(b)),
    );
  if (metadataKey(before) !== metadataKey(after)) fields.push("metadata");
  if (before.allowedTools !== after.allowedTools) fields.push("allowedTools");
  const droppedKey = (skill: LoadedSkill) =>
    JSON.stringify({
      rows: skill.dropped
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((item) => [item.path, item.reason]),
      more: skill.droppedMore,
    });
  if (droppedKey(before) !== droppedKey(after)) fields.push("dropped");
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const added = [...newFiles.keys()].filter((path) => !oldFiles.has(path));
  const removed = [...oldFiles.keys()].filter((path) => !newFiles.has(path));
  const changed = [...newFiles].flatMap(([path, file]) => {
    const old = oldFiles.get(path);
    return old && old.content !== file.content ? [path] : [];
  });
  const body = before.body !== after.body;
  const description = before.description !== after.description;
  if (
    !body &&
    !description &&
    fields.length === 0 &&
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0
  )
    return null;
  return {
    at: now,
    body,
    description,
    fields,
    files: { added, removed, changed },
  };
}
