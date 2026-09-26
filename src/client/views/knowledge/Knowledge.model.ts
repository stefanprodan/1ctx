// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words of the Knowledge tab and every check it makes, apart from
// the view so both are read without a DOM: the totals, the tree's
// nodes, who wrote a file and from where, the lists the head switches
// between, and the marks a search puts on a name or a line.

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeTotals,
} from "../../../shared/contracts/knowledge.ts";
import { ago, count, plural } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import type { IconName } from "../../lib/icons.tsx";
import { FOLDER_ROWS, type TreeFolder } from "../../lib/tree.ts";
import type { RowsTreeNode } from "../../ui/Rows.tsx";

// the aside's line: "6 files · 6.6K tokens"
export function knowledgeWords(counts: KnowledgeCounts | KnowledgeTotals) {
  return `${plural(counts.files, "file")} · ${plural(counts.tokens, "token")}`;
}

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/knowledge`;

// a file's page, at a line when a search hit names one
export function fileHref(
  projectId: string,
  fileId: string,
  line?: number,
): string {
  const at = line === undefined ? "" : `?line=${line}`;
  return `${project(projectId)}/files/${encodeURIComponent(fileId)}${at}`;
}

// a past revision's page; the file itself when it is the latest
export function revisionHref(
  projectId: string,
  fileId: string,
  revision: number,
  latest?: number,
): string {
  const file = fileHref(projectId, fileId);
  return revision === latest ? file : `${file}?revision=${revision}`;
}

export const historyHref = (projectId: string, fileId: string): string =>
  `${fileHref(projectId, fileId)}?history`;

// a file just brought back from the bin
export const restoredHref = (projectId: string, fileId: string): string =>
  `${fileHref(projectId, fileId)}?restored`;

export function newFileHref(projectId: string): string {
  return `${project(projectId)}/new`;
}

// the head's three lists, each an address so back and a shared link
// keep the pick
export type KnowledgeListName = "files" | "recent" | "deleted";

export function listOf(query: string): KnowledgeListName {
  const list = new URLSearchParams(query).get("list");
  return list === "recent" || list === "deleted" ? list : "files";
}

export function listHref(projectId: string, list: KnowledgeListName): string {
  return list === "files"
    ? project(projectId)
    : `${project(projectId)}?list=${list}`;
}

// ?folder= opens that folder and its parents; null when absent
export function folderParam(query: string): string | null {
  const folder = new URLSearchParams(query).get("folder");
  return folder === null || folder.trim() === "" ? null : folder;
}

// who wrote a file and from where: the name as it was at the write, its
// page, and the chat or the run it was written from
export type AuthorWords = {
  name: string;
  href: string;
  where: string | null;
  sessionId: string | null;
};

export function authorOf(author: KnowledgeAuthor): AuthorWords {
  return {
    name: author.name,
    href:
      author.kind === "user" ? userHref(author.name) : agentHref(author.name),
    where:
      author.sessionId === null
        ? null
        : author.origin === "automation"
          ? "in a run"
          : "in a chat",
    sessionId: author.sessionId,
  };
}

// an agent's write stands out in the tree for this long
const FRESH_MS = 3 * 86_400_000;

export function fresh(file: KnowledgeFile, now: number): boolean {
  return file.author.kind === "agent" && now - file.updatedAt < FRESH_MS;
}

const PROSE = new Set([
  "",
  "md",
  "markdown",
  "txt",
  "text",
  "rst",
  "adoc",
  "log",
]);
const DATA = new Set([
  "yaml",
  "yml",
  "json",
  "jsonl",
  "toml",
  "csv",
  "tsv",
  "ini",
  "conf",
  "cfg",
  "env",
  "xml",
  "properties",
  "lock",
]);
const VISUAL = new Set(["html", "htm", "svg"]);
const CODE = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "lua",
  "sql",
  "css",
  "scss",
  "dockerfile",
  "makefile",
  "mk",
  "nix",
  "pl",
  "r",
  "scala",
  "dart",
  "ex",
  "exs",
  "hs",
  "proto",
  "graphql",
  "tf",
  "patch",
  "diff",
]);

// a file's icon by its kind: prose, code, data, a visual, or a page. A
// name without a dot is known by itself (Dockerfile, Makefile)
export function fileIcon(name: string): IconName {
  const base = (name.split("/").at(-1) ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const k = dot > 0 ? base.slice(dot + 1) : CODE.has(base) ? base : "";
  if (PROSE.has(k)) return "file-text";
  if (CODE.has(k)) return "code";
  if (DATA.has(k)) return "braces";
  if (VISUAL.has(k)) return "visual";
  return "file";
}

// a lone folder the user closed, in the open folders' set
export const CLOSED = "!";

// the tree's rows: each folder's folders, then its files, a folder past
// FOLDER_ROWS files ending in a row that shows the rest
export function treeNodes(
  folder: TreeFolder<KnowledgeFile>,
  view: {
    open: ReadonlySet<string>;
    // the folders whose every file is shown
    all: ReadonlySet<string>;
    now: number;
    href: (file: KnowledgeFile) => string;
    toggle: (path: string) => void;
    showAll: (path: string) => void;
  },
): RowsTreeNode[] {
  // a folder alone at its level opens by itself, as there is nothing
  // else to pick there; closing it is kept as its path marked with !
  const lone = folder.folders.length === 1 && folder.items.length === 0;
  const nodes: RowsTreeNode[] = folder.folders.map((sub) => {
    const key = lone ? `${CLOSED}${sub.path}` : sub.path;
    const open = lone ? !view.open.has(key) : view.open.has(key);
    return {
      kind: "folder",
      key: `d:${sub.path}`,
      name: sub.name,
      count: sub.count,
      open,
      onToggle: () => view.toggle(key),
      children: open ? treeNodes(sub, view) : [],
    };
  });
  const whole = view.all.has(folder.path) || folder.items.length <= FOLDER_ROWS;
  const items = whole ? folder.items : folder.items.slice(0, FOLDER_ROWS);
  for (const file of items) {
    nodes.push({
      kind: "file",
      key: file.id,
      name: file.name.slice(folder.path === "" ? 0 : folder.path.length + 1),
      href: view.href(file),
      meta: ago(file.updatedAt, view.now),
      lit: fresh(file, view.now),
      title: file.name,
      icon: fileIcon(file.name),
    });
  }
  if (!whole) {
    const rest = folder.items.length - FOLDER_ROWS;
    nodes.push({
      kind: "more",
      key: `m:${folder.path}`,
      label: `Show ${count(rest)} more in ${folder.name || "this folder"}`,
      onPick: () => view.showAll(folder.path),
    });
  }
  return nodes;
}

// a name split where its folder ends, the folder drawn faint
export function pathParts(name: string): { dir: string; base: string } {
  const at = name.lastIndexOf("/") + 1;
  return { dir: name.slice(0, at), base: name.slice(at) };
}

// a text in runs, every place it holds q marked, not case-sensitive
type Marked = { text: string; mark: boolean }[];

export function marked(text: string, q: string): Marked {
  const needle = q.toLowerCase();
  if (needle === "") return text === "" ? [] : [{ text, mark: false }];
  const hay = text.toLowerCase();
  const out: Marked = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push({ text: text.slice(from, at), mark: false });
    out.push({ text: text.slice(at, at + needle.length), mark: true });
    from = at + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), mark: false });
  return out;
}

// the Names group's label and what is left past the names answered
export const NAME_ROWS = 5;

export function namesWords(
  shown: number,
  total: number,
): { label: string; beyond: string | null } {
  return {
    label: `Names · ${count(total)}`,
    beyond:
      total > shown
        ? `${plural(total - shown, "more name")}. Type more to narrow them.`
        : null,
  };
}

// a row of the Deleted list: "deleted by sre in a run · 4d ago"
export function deletedLine(
  file: KnowledgeDeleted,
  now: number,
): { author: AuthorWords; when: string } {
  return { author: authorOf(file.deletedBy), when: ago(file.deletedAt, now) };
}

// the Deleted list's band: how long a deleted file's text is kept, and
// what Empty bin asks
export function keptWords(historyDays: number): string {
  return `A deleted file's text is kept up to ${plural(historyDays, "day")}.`;
}

export function emptyAsk(files: number): string {
  return `Are you sure you want to permanently erase ${plural(files, "file")}?`;
}
