// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the knowledge pages: the Recent and Deleted lists
// drawn from the list held, the folders a link opens, the revision a
// page shows and the one it is compared with, and how a file page takes
// another writer's word without swapping the text under its reader.

import type {
  KnowledgeAuthor,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeFileView,
  KnowledgeVersion,
} from "../../shared/contracts/knowledge.ts";
import type { Failure } from "../lib/format.ts";

export const RECENT_PAGE = 12;

// every live file by its last change, newest first, pages of
// RECENT_PAGE paged in memory
export function recentFiles(
  files: readonly KnowledgeFile[],
  pages: number,
): { rows: KnowledgeFile[]; more: boolean } {
  const sorted = files
    .slice()
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "en"),
    );
  const shown = Math.max(1, pages) * RECENT_PAGE;
  return { rows: sorted.slice(0, shown), more: sorted.length > shown };
}

// one row per name, its newest delete, newest first: a name deleted
// twice leaves two ids, and the older is in the history of neither page
export function deletedByName(
  deleted: readonly KnowledgeDeleted[],
): KnowledgeDeleted[] {
  const newest = new Map<string, KnowledgeDeleted>();
  for (const row of deleted) {
    const held = newest.get(row.name);
    if (held === undefined || held.deletedAt < row.deletedAt) {
      newest.set(row.name, row);
    }
  }
  return [...newest.values()].sort((a, b) => b.deletedAt - a.deletedAt);
}

// "plans/x/y" opens plans, plans/x and plans/x/y, so a crumb's link
// lands with its folder in view
export function withParents(folder: string): string[] {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

// the folder a name sits in, empty at the root
export function folderOf(name: string): string {
  const at = name.lastIndexOf("/");
  return at < 0 ? "" : name.slice(0, at);
}

// the version a deleted file's page and its Restore show: the newest
// that holds a text, since a delete writes an empty one
export function lastLiveVersion(
  versions: readonly KnowledgeVersion[],
): KnowledgeVersion | null {
  return versions.find((version) => !version.deleted) ?? null;
}

// a past revision and the one it is compared with, the live version
// before it; versions come newest first
export function revisionPair(
  versions: readonly KnowledgeVersion[],
  revision: number,
): { version: KnowledgeVersion | null; before: KnowledgeVersion | null } {
  const at = versions.findIndex(
    (version) => version.revision === revision && !version.deleted,
  );
  if (at < 0) return { version: null, before: null };
  const before =
    versions.slice(at + 1).find((version) => !version.deleted) ?? null;
  return { version: versions[at] ?? null, before };
}

// ?revision= as a number, null when absent or not a revision
export function revisionParam(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,8}$/.test(value)) return null;
  return Number(value);
}

// who deleted the file on screen, when, and the delete's revision, so
// an answer to an earlier write never brings the file back
export type DocDeleted = { by: KnowledgeAuthor; at: number; revision: number };

// a file's page. done holds the text the reader sees; newer is the row
// of a write by someone else the page has not shown, deleted says the
// file went while the page was open, the text kept, and failure that a
// load again failed, the text kept for its reader
export type DocFile =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "failed"; failure: Failure }
  | {
      state: "done";
      file: KnowledgeFileView;
      newer: KnowledgeFile | null;
      deleted: DocDeleted | null;
      failure: Failure | null;
    };

export const DOC_LOADING: DocFile = { state: "loading" };

// a row the page learned of, from a frame or the list, against what it
// shows: a newer live revision is a notice, a delete marks the page,
// and anything at or under what it shows, or at or under a revision the
// page wrote itself, changes nothing
export function noticeRow(
  doc: DocFile,
  row: KnowledgeFile,
  deleted: DocDeleted | null,
  wrote: number,
): DocFile {
  if (doc.state !== "done" || row.id !== doc.file.id) return doc;
  if (deleted !== null) {
    if (doc.deleted !== null) return doc;
    return { ...doc, newer: null, deleted };
  }
  if (doc.deleted !== null) return doc;
  if (row.revision <= Math.max(doc.file.revision, wrote)) return doc;
  if (doc.newer !== null && doc.newer.revision >= row.revision) return doc;
  return { ...doc, newer: row };
}

// a read of the file: swapped in on arrival, else kept apart as the
// latest while the page shows what its reader was reading
export function takeView(
  doc: DocFile,
  view: KnowledgeFileView,
  swap: boolean,
  wrote: number,
): DocFile {
  const same = doc.state === "done" && doc.file.id === view.id;
  // a read from before the delete never brings the file back
  if (same && doc.deleted !== null && doc.deleted.revision > view.revision) {
    return doc;
  }
  if (
    swap ||
    doc.state !== "done" ||
    !same ||
    doc.file.revision === view.revision
  ) {
    return {
      state: "done",
      file: view,
      newer:
        same && doc.newer !== null && doc.newer.revision > view.revision
          ? doc.newer
          : null,
      deleted: null,
      failure: null,
    };
  }
  if (view.revision < doc.file.revision) return doc;
  return noticeRow(doc, view, null, wrote);
}

// the key set last, the least recent dropped past size
export function capped<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V,
  size: number,
): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  for (const oldest of next.keys()) {
    if (next.size <= size) break;
    next.delete(oldest);
  }
  return next;
}

// two queries that differ at most in ?line=
export function sameBesidesLine(a: string, b: string): boolean {
  const rest = (search: string) => {
    const query = new URLSearchParams(search);
    query.delete("line");
    query.sort();
    return query.toString();
  };
  return rest(a) === rest(b);
}
