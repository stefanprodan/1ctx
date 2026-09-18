// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the Knowledge tab and every check it makes, apart from
// the view so both are read without a DOM: the totals, a row's head
// line, who wrote it and from where, the text cut to its first lines,
// the history lines and the Deleted card.

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeTotals,
  KnowledgeVersion,
} from "../../../shared/contracts/knowledge.ts";
import { prefixConflict } from "../../../shared/knowledge.ts";
import { isKnowledgeName } from "../../../shared/words.ts";
import { ago, count } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import { matches } from "../../lib/search.ts";

// "1 file", "6.6k tokens"
export function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? "" : "s"}`;
}

// the card's hint and the aside's line: "6 files · 6.6k tokens"
export function knowledgeWords(counts: KnowledgeCounts | KnowledgeTotals) {
  return `${plural(counts.files, "file")} · ${plural(counts.tokens, "token")}`;
}

// the rows the search leaves, by name
export function shownFiles<T extends { name: string }>(
  files: readonly T[],
  q: string,
): T[] {
  return files.filter((file) => matches(q, [file.name]));
}

// who wrote a file and from where: the name as it was at the write, its
// page, and the chat or the run it was written from
export type AuthorWords = {
  name: string;
  href: string;
  // a user is a handle, an agent is its name
  handle: boolean;
  where: string | null;
  sessionId: string | null;
};

export function authorOf(author: KnowledgeAuthor): AuthorWords {
  return {
    name: author.name,
    href:
      author.kind === "user" ? userHref(author.name) : agentHref(author.name),
    handle: author.kind === "user",
    where:
      author.sessionId === null
        ? null
        : author.origin === "automation"
          ? "in a run"
          : "in a chat",
    sessionId: author.sessionId,
  };
}

// the faint line under a file's name: "md · 84 lines · sre in a run ·
// 2h ago"; a name without an extension reads "text"
export type HeadLine = {
  kind: string;
  lines: string;
  author: AuthorWords;
  when: string;
};

export function headLine(file: KnowledgeFile, now: number): HeadLine {
  return {
    kind: file.kind === "" ? "text" : file.kind,
    lines: plural(file.lines, "line"),
    author: authorOf(file.author),
    when: ago(file.updatedAt, now),
  };
}

// the file's text folded to its first lines; a text of TEXT_LINES or
// fewer has no button
export const TEXT_LINES = 12;

export function textBox(
  text: string,
  expanded: boolean,
): { text: string; canToggle: boolean; label: string } {
  const lines = text.replace(/\n$/, "").split("\n");
  const canToggle = lines.length > TEXT_LINES;
  return {
    text: canToggle && !expanded ? lines.slice(0, TEXT_LINES).join("\n") : text,
    canToggle,
    label: expanded ? "Show less" : `Show all ${plural(lines.length, "line")}`,
  };
}

// a row of History: "Revision 3" over who wrote it, when, and whether
// it is the file as it stands
export type VersionLine = {
  label: string;
  author: AuthorWords;
  when: string;
  current: boolean;
  deleted: boolean;
};

export function versionLine(
  version: KnowledgeVersion,
  current: boolean,
  now: number,
): VersionLine {
  return {
    label: `Revision ${version.revision}`,
    author: authorOf(version.author),
    when: ago(version.writtenAt, now),
    current,
    deleted: version.deleted,
  };
}

// the version Restore brings back: the newest that holds a text, since
// a delete writes an empty one
export function lastLiveVersion(
  versions: readonly KnowledgeVersion[],
): KnowledgeVersion | null {
  return versions.find((version) => !version.deleted) ?? null;
}

// a row of the Deleted card: "deleted by sre in a run · 4d ago"
export function deletedLine(
  file: KnowledgeDeleted,
  now: number,
): { author: AuthorWords; when: string } {
  return { author: authorOf(file.deletedBy), when: ago(file.deletedAt, now) };
}

// the Deleted card's hint: how long a deleted file's text is kept
export function deletedHint(historyDays: number): string {
  return `kept ${plural(historyDays, "day")}`;
}

// the Name box's hint: the rule in words, since a path is not a name
// the field can shape into shape on its own
export const NAME_HINT =
  "One to eight segments of letters, digits, dot, dash and underscore, like docs/runbook.md";

// the name a new file may take: the rule, the names in the base, and
// the rule that no file is another file's directory
export function nameProblem(
  value: string,
  names: readonly string[],
): string | null {
  const name = value.trim();
  if (name === "") return "Enter a name";
  if (!isKnowledgeName(name)) return NAME_HINT;
  if (names.includes(name)) return `a file named ${name} exists`;
  const clash = prefixConflict(name, names);
  if (clash === null) return null;
  return name.startsWith(`${clash}/`)
    ? `${clash} is a file`
    : `${clash} is inside it`;
}

// the name box shapes what is typed, as every name field does: no
// spaces and no ends to trim
export function shapeKnowledgeName(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

// a picked file's name without its directories
export function baseName(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf("/") + 1);
}

const ENCODER = new TextEncoder();

export function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

// a size as a field says it: "256 KB", "4 MB"
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${Number((bytes / 1024).toPrecision(3))} KB`;
  }
  return `${Number((bytes / (1024 * 1024)).toPrecision(3))} MB`;
}

export function textHint(fileBytes: number): string {
  return `Any UTF-8 text up to ${sizeWords(fileBytes)}`;
}

// the browser decodes a file it cannot read into U+FFFD, so a text
// holding one, or a NUL, is not a text file the base takes
export function textProblem(text: string, fileBytes: number): string | null {
  if (text === "") return "Add some text";
  if (text.includes("\uFFFD") || text.includes("\u0000")) {
    return "Not a text file";
  }
  const bytes = byteLength(text);
  if (bytes > fileBytes) {
    return `Too large: ${sizeWords(bytes)}, the cap is ${sizeWords(fileBytes)}`;
  }
  return null;
}

// JSON escaping can grow a character to six bytes, so what goes on the
// wire is measured too, against the cap the route reads a body with
export const BODY_FACTOR = 3;

export function bodyProblem(body: unknown, fileBytes: number): string | null {
  const bytes = byteLength(JSON.stringify(body));
  const cap = fileBytes * BODY_FACTOR;
  if (bytes <= cap) return null;
  return `Too large to send: ${sizeWords(bytes)}, the cap is ${sizeWords(cap)}`;
}

// which field the server's refusal is about
export function fieldOf(message: string): string | undefined {
  const words = message.toLowerCase();
  if (
    words.startsWith("name") ||
    words.includes("a file named") ||
    words.includes("is a file") ||
    words.includes("is inside")
  ) {
    return "name";
  }
  if (words.startsWith("text") || words.includes("text file")) return "text";
  return undefined;
}
