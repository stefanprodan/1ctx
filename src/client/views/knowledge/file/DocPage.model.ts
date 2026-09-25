// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of a knowledge file's page: the crumb, the outline of a
// rendered Markdown file, the history's pages and what its limits
// dropped, and which refusal is the path field's. The words the tab
// draws too (who, sizes, counts) are the tab's, in Knowledge.model.ts.

import type { KnowledgeVersion } from "../../../../shared/contracts/knowledge.ts";
import { baseName, foldersOf } from "../../../lib/tree.ts";
import type { PageStep } from "../../../ui/Page.tsx";
import { listHref, newFileHref } from "../Knowledge.model.ts";

export const HISTORY_PAGE = 10;
// the outline is offered from this many headings
export const OUTLINE_FROM = 3;

// the tab with a folder of the tree open, as a crumb's step leads
export const folderHref = (projectId: string, folder: string): string =>
  `${listHref(projectId, "files")}?folder=${encodeURIComponent(folder)}`;

// a new file starting in a folder, the top one when empty
export const newFileIn = (projectId: string, folder: string): string =>
  `${newFileHref(projectId)}${
    folder === "" ? "" : `?folder=${encodeURIComponent(folder)}`
  }`;

// the folders that hold a live file, the only ones the tree draws: a
// folder is a prefix of live names, never a row of its own
export function liveFolders(
  files: readonly { name: string }[],
): ReadonlySet<string> {
  const folders = new Set<string>();
  for (const file of files) {
    for (const folder of foldersOf(file.name)) folders.add(folder);
  }
  return folders;
}

// the crumb before the title: the project, the base, then each folder
// (foldersOf: "a", "a/b") in mono, a link back to the tree with that
// folder open. A deleted file's folder may hold nothing live any more:
// given the live folders, such a step is words, not a link to a tree
// that no longer draws it
export function crumbSteps(
  projectId: string,
  projectName: string,
  folders: readonly string[],
  live: ReadonlySet<string> | null = null,
): PageStep[] {
  const step = (folder: string): PageStep => ({
    label: baseName(folder),
    href:
      live === null || live.has(folder)
        ? folderHref(projectId, folder)
        : undefined,
    mono: true,
    title: folder,
  });
  // past two folders the middle ones fold into …, which opens the
  // deepest of them and names the whole path on hover
  const shown =
    folders.length <= 2
      ? folders.map(step)
      : [
          step(folders[0]!),
          // never cut itself, as a path's step is
          { ...step(folders.at(-2)!), label: "…", mono: false },
          step(folders.at(-1)!),
        ];
  return [
    { label: projectName, href: `/projects/${encodeURIComponent(projectId)}` },
    { label: "Knowledge", href: listHref(projectId, "files") },
    ...shown,
  ];
}

export const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

export type OutlineEntry = { level: 2 | 3; text: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

// the second and third level headings of the server's rendered
// Markdown, in order; the first level is the file's own title
export function outlineOf(html: string | null): OutlineEntry[] {
  if (html === null) return [];
  const out: OutlineEntry[] = [];
  for (const m of html.matchAll(/<h([23]) class="md-h\1">([\s\S]*?)<\/h\1>/g)) {
    const text = (m[2] ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ENTITIES[e]!)
      .trim();
    if (text !== "") out.push({ level: m[1] === "3" ? 3 : 2, text });
  }
  return out;
}

// the history's versions a reader can open: the live ones, newest first
export const liveVersions = (
  versions: readonly KnowledgeVersion[],
): KnowledgeVersion[] => versions.filter((version) => !version.deleted);

// the revisions the history's limits dropped: 1 to the one before the
// oldest kept, none when the first is still kept
export function droppedBefore(versions: readonly KnowledgeVersion[]): number {
  const live = liveVersions(versions);
  const oldest = live[live.length - 1];
  return oldest === undefined ? 0 : oldest.revision - 1;
}

export function droppedWords(dropped: number): string {
  const which =
    dropped === 1 ? "Revision 1 was" : `Revisions 1 to ${dropped} were`;
  return `${which} dropped to keep the history under its limits.`;
}

// the revisions either side of one, for the ‹ › steps: older is the one
// before it, newer the one after, the file as it is included
export function revisionSteps(
  versions: readonly KnowledgeVersion[],
  revision: number,
): { older: number | null; newer: number | null } {
  const live = liveVersions(versions);
  const at = live.findIndex((version) => version.revision === revision);
  if (at < 0) return { older: null, newer: null };
  const older = live[at + 1]?.revision ?? null;
  const next = live[at - 1]?.revision ?? null;
  return { older, newer: next };
}

// a refusal the path field owns: the name's rule, a taken name, a
// folder that is a file, the same name
export function pathFieldOf(message: string): string | undefined {
  const path =
    /^name must|^a file named|conflicts with file|is named .* already/i;
  return path.test(message) ? "path" : undefined;
}

// a stale revision's 409: the file was written since the page read it
export const isStale = (status: number, message: string): boolean =>
  status === 409 && /is at revision \d+/.test(message);

// a typed path: spaces become dashes, as a name field shapes its input
export const shapePath = (value: string): string => value.replace(/ /g, "-");

// a path the page can create or rename to: something after the last slash
export const pathReady = (value: string): boolean =>
  value.trim() !== "" && !value.endsWith("/");

// the text box's rows: its lines and room for two more
export const editorRows = (text: string): number => text.split("\n").length + 2;

// ?line= and ?revision= as a number, null when absent or not one
export function numberParam(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,8}$/.test(value)) return null;
  return Number(value);
}
