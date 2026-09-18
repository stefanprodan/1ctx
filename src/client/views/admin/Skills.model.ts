// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the skills page shows and checks without a DOM: which form the
// pasted URL takes and what its button says, the words on a row's
// head and inside it, the bytes and change words, and the cut a long
// body gets.

import type {
  SkillChange,
  SkillSummary,
} from "../../../shared/contracts/skill.ts";
import { sourceForm } from "../../../shared/skills.ts";
import type { SkillSource } from "../../../shared/words.ts";
import { ago, longDate } from "../../lib/format.ts";

export { firstSentence } from "../../lib/format.ts";

export const URL_HINT =
  "A site with skills, a GitHub directory, a raw SKILL.md, or a zip or tar archive.";

// the form's shape follows the URL as it is typed: null until it is one
export function formKind(url: string): SkillSource | null {
  return sourceForm(url)?.kind ?? null;
}

// what the submit does for the kind: an index is looked up first
export function submitLabel(kind: SkillSource | null): string {
  return kind === "index" ? "Look up" : "Add skill";
}

export function urlProblem(url: string): string | null {
  if (url.trim() === "") return "Paste a URL";
  if (formKind(url) === null) return "Not an http(s) URL";
  return null;
}

// a path inside an archive: relative, no climbing, no odd characters
export function pathProblem(path: string): string | null {
  const p = path.trim();
  if (p === "") return null;
  if (p.startsWith("/") || p.includes("\\")) return "A relative path";
  if (p.split("/").some((s) => s === "..")) return "A path inside the archive";
  return null;
}

// "1.2 KB", "37 KB", "612 B"
export function bytesWord(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Number((n / 1024).toPrecision(3))} KB`;
  return `${Number((n / (1024 * 1024)).toPrecision(3))} MB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// the faint line under the name: the files and the fetch, or the
// failure in red
export function metaLine(
  skill: Pick<
    SkillSummary,
    "files" | "fetchedAt" | "refreshError" | "refreshFailedAt"
  >,
  now: number,
): { text: string; bad: boolean } {
  if (skill.refreshError !== null && skill.refreshFailedAt !== null) {
    return {
      text: `Refresh failed ${ago(skill.refreshFailedAt, now)}`,
      bad: true,
    };
  }
  // SKILL.md is a file too, so a skill always has one
  const files = plural(skill.files.length + 1, "file");
  return {
    text: `${files} · fetched ${ago(skill.fetchedAt, now)}`,
    bad: false,
  };
}

// where the skill came from, in words
export function sourceLine(
  skill: Pick<
    SkillSummary,
    "sourceKind" | "sourceUrl" | "sourceSelect" | "sourceDigest"
  >,
): string {
  const form = sourceForm(skill.sourceUrl);
  switch (skill.sourceKind) {
    case "github":
      return form?.kind === "github"
        ? `GitHub, ${form.ref}, ${form.path === "" ? "the root" : form.path}`
        : "GitHub";
    case "archive":
      return skill.sourceSelect === ""
        ? "Archive, at its root"
        : `Archive, ${skill.sourceSelect}`;
    case "index": {
      const host = form === null ? "" : new URL(skill.sourceUrl).host;
      return `${host === "" ? "Index" : host}, ${
        skill.sourceDigest === "" ? "no digest" : "digest checked"
      }`;
    }
    default:
      return "Raw SKILL.md";
  }
}

// what the last refresh found, in a sentence: "Body changed, 2 files
// added, 1 file removed" when the latest fetch changed something, else
// "Same as 12 September 2026", the day it was last changed or added
export function changeLine(
  change: SkillChange | null,
  fetchedAt: number,
  createdAt: number,
): string {
  if (change === null) return `Same as ${longDate(createdAt)}`;
  if (change.at < fetchedAt) return `Same as ${longDate(change.at)}`;
  const parts: string[] = [];
  if (change.body) parts.push("body changed");
  if (change.description) parts.push("description changed");
  if (change.fields.length > 0) {
    parts.push(`${change.fields.join(", ")} changed`);
  }
  const { added, removed, changed } = change.files;
  if (added.length > 0) parts.push(`${plural(added.length, "file")} added`);
  if (removed.length > 0) {
    parts.push(`${plural(removed.length, "file")} removed`);
  }
  if (changed.length > 0) {
    parts.push(`${plural(changed.length, "file")} changed`);
  }
  if (parts.length === 0) return `Changed ${longDate(change.at)}`;
  const text = parts.join(", ");
  return `${text[0]!.toUpperCase()}${text.slice(1)} ${longDate(change.at)}`;
}

// "3 files not kept: assets/logo.png (binary), ... and 12 more"
export function droppedLine(
  skill: Pick<SkillSummary, "dropped" | "droppedMore">,
): string {
  if (skill.dropped.length === 0) return "";
  const total = skill.dropped.length + skill.droppedMore;
  const list = skill.dropped.map((d) => `${d.path} (${d.reason})`).join(", ");
  const more = skill.droppedMore > 0 ? ` and ${skill.droppedMore} more` : "";
  return `${plural(total, "file")} not kept: ${list}${more}`;
}

// the metadata as "key: value" lines, in key order
export function metadataLines(metadata: Record<string, string>): string[] {
  return Object.keys(metadata)
    .sort()
    .map((key) => `${key}: ${metadata[key]}`);
}
