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
import { ago, count } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import { matches } from "../../lib/search.ts";

// "1 file", "6.6K tokens"
export function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? "" : "s"}`;
}

// the card's hint and the aside's line: "6 files · 6.6K tokens"
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

// a size as a field says it: "256 KB", "4 MB"
// three significant digits, but never a rounded thousand: 1,023.5 MB
// to three digits is "1020 MB", so the next unit takes over at 1,000
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  for (const unit of ["KB", "MB", "GB"]) {
    value /= 1024;
    if (value < 1000 || unit === "GB") {
      const shown =
        value < 100 ? Number(value.toPrecision(3)) : Math.round(value);
      return `${shown} ${unit}`;
    }
  }
  return `${bytes} B`;
}
