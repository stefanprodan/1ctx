// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeUploadReason,
  KnowledgeUploadResult,
} from "../../shared/contracts/knowledge.ts";
import {
  isLeftOut,
  normalizeKnowledgePath,
  prefixConflict,
  splitRawPath,
  textFromBytes,
} from "../../shared/knowledge.ts";
import { uploadFolder } from "../../shared/uploads.ts";
import type { ArchiveMember } from "../lib/archive.ts";

type Skip = KnowledgeUploadResult["skipped"][number];
type Candidate = { index: number; name: string; renamed: boolean };
export type Selection = { candidates: Candidate[]; skipped: Skip[] };
export type JudgedFile = { name: string; text: string; replaces: boolean };

function skip(
  member: ArchiveMember,
  reason: KnowledgeUploadReason,
  other?: number,
): Skip {
  return {
    index: member.index,
    name: skippedName(member.name),
    reason,
    ...(other === undefined ? {} : { other }),
  };
}

export function skippedName(raw: string): string {
  const cut = raw.slice(0, 200);
  if (Buffer.byteLength(JSON.stringify(cut)) <= 300) return cut;
  // A character cap alone cannot bound UTF-8 or JSON-escaped controls.
  let name = "";
  let bytes = 2;
  for (const character of cut) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > 300) break;
    name += character;
  }
  return name;
}

export function selectMembers(
  manifest: readonly ArchiveMember[],
  folder: string,
): Selection {
  const skipped: Skip[] = [];
  const groups = new Map<string, Candidate[]>();
  for (const member of manifest) {
    if (member.type === "directory" || isLeftOut(member.name)) continue;
    if (member.type !== "file") {
      skipped.push(skip(member, "not-regular"));
      continue;
    }
    const normalized = normalizeKnowledgePath(member.name);
    if (!normalized.ok) {
      skipped.push(skip(member, normalized.reason));
      continue;
    }
    const joined = folder ? `${folder}/${normalized.name}` : normalized.name;
    const name = normalizeKnowledgePath(joined);
    if (!name.ok) {
      skipped.push(skip(member, name.reason));
      continue;
    }
    const group = groups.get(name.name) ?? [];
    group.push({
      index: member.index,
      name: name.name,
      // A leading ./ or a doubled slash is spelling, not a rename.
      renamed: normalized.name !== splitRawPath(member.name).join("/"),
    });
    groups.set(name.name, group);
  }
  const candidates: Candidate[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) candidates.push(group[0]!);
    else {
      for (const member of group) {
        const other = group[0]!.index === member.index ? group[1]! : group[0]!;
        skipped.push(skip(manifest[member.index]!, "duplicate", other.index));
      }
    }
  }
  return { candidates, skipped };
}

export function selectUploadMembers(
  manifest: readonly ArchiveMember[],
  name: string,
): Selection & { folder: string } {
  const selection = selectMembers(manifest, "");
  const root = selection.candidates[0]?.name.split("/")[0];
  if (
    root &&
    selection.candidates.every((file) => file.name.startsWith(`${root}/`))
  ) {
    return { ...selection, folder: "" };
  }
  const folder = uploadFolder(name);
  return { ...selectMembers(manifest, folder), folder };
}

export function judgeMembers(
  manifest: readonly ArchiveMember[],
  selection: Selection,
  live: ReadonlyMap<string, { bytes: number; text: string }>,
  fileBytes: number,
): { files: JudgedFile[]; result: KnowledgeUploadResult } {
  const skipped = [...selection.skipped];
  const eligible: (Candidate & { text: string })[] = [];
  for (const candidate of selection.candidates) {
    const member = manifest[candidate.index]!;
    if (member.data === undefined) {
      throw new Error("an upload member was not read");
    }
    if (
      member.data.byteLength > fileBytes &&
      member.data.byteLength >= (live.get(candidate.name)?.bytes ?? 0)
    ) {
      skipped.push(skip(member, "too-big"));
      continue;
    }
    let text: string;
    try {
      text = textFromBytes(member.data);
    } catch {
      skipped.push(skip(member, "not-text"));
      continue;
    }
    eligible.push({ ...candidate, text });
  }

  // Decide the whole eligible tree before removing a clash. Removing in
  // archive order would let the last of a conflicting pair silently win.
  const names = new Map(eligible.map((file) => [file.name, file.index]));
  const clashes = new Map<number, number>();
  const clash = (index: number, other: number) =>
    clashes.set(index, Math.min(clashes.get(index) ?? other, other));
  for (const file of eligible) {
    const parts = file.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = names.get(parts.slice(0, i).join("/"));
      if (parent === undefined) continue;
      clash(file.index, parent);
      clash(parent, file.index);
    }
  }
  const liveNames = [...live.keys()];
  const files: JudgedFile[] = [];
  const result: KnowledgeUploadResult = {
    added: 0,
    replaced: 0,
    unchanged: 0,
    renamed: 0,
    saved: [],
    skipped: [],
    skippedTotal: 0,
  };
  for (const file of eligible) {
    const member = manifest[file.index]!;
    const other = clashes.get(file.index);
    if (other !== undefined) {
      skipped.push(skip(member, "clash", other));
      continue;
    }
    if (prefixConflict(file.name, liveNames) !== null) {
      skipped.push(skip(member, "clash-live"));
      continue;
    }
    const before = live.get(file.name);
    if (before?.text === file.text) {
      result.unchanged++;
      continue;
    }
    files.push({
      name: file.name,
      text: file.text,
      replaces: before !== undefined,
    });
    if (before === undefined) result.added++;
    else result.replaced++;
    if (file.renamed) result.renamed++;
    if (result.saved.length < 200) result.saved.push(file.name);
  }
  result.skippedTotal = skipped.length;
  result.skipped = skipped.sort((a, b) => a.index - b.index).slice(0, 200);
  return { files, result };
}
