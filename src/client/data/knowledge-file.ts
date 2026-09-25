// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A knowledge file's page: the file by id with its text and rendering,
// held per file so a page seen before draws at once. The text on screen
// is the reader's: another writer's revision, from a frame, the list or
// a load again, is kept as a notice until showLatest(), a delete marks
// the page with the text kept, and a failed load again is said beside
// the text. A write from this page updates it directly; while it is on
// its way, what the page learns of the file waits, so its own frame is
// never taken for someone else's.

import { batch, effect, signal, untracked } from "@preact/signals";
import type { KnowledgeFileDetailResponse } from "../../shared/api/knowledge.ts";
import type {
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeFileView,
} from "../../shared/contracts/knowledge.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { path } from "../app/router.ts";
import { failure } from "../lib/format.ts";
import { ApiError, api } from "./api.ts";
import {
  addFile,
  knowledgeOf,
  lists,
  loadKnowledge,
  removeFile,
  renameKnowledgeFile,
  replaceFile,
} from "./knowledge.ts";
import {
  forgetHistories,
  historyHeld,
  loadDeletedText,
  loadHistory,
  loadRevision,
} from "./knowledge-history.ts";
import {
  capped,
  DOC_LOADING,
  type DocDeleted,
  type DocFile,
  noticeRow,
  revisionParam,
  sameBesidesLine,
  takeView,
} from "./knowledge-rows.ts";
import { me } from "./me.ts";
import { onSocketEvent } from "./socket.ts";

const HELD_FILES = 16;

export const docFiles = signal<ReadonlyMap<string, DocFile>>(new Map());

export const docFileOf = (fileId: string): DocFile =>
  docFiles.value.get(fileId) ?? DOC_LOADING;

type Learned = { row: KnowledgeFile; deleted: DocDeleted | null };

let owner: string | null = null;
// one count for every load and write, so a turn dropped with its entry
// is never taken for a later one
let seq = 0;
const fileTurns = new Map<string, number>();
// the project of each page held, for a revocation and a bin emptied
const docProjects = new Map<string, string>();
// the newest revision this tab wrote, per file
const wrote = new Map<string, number>();
// the files with a write on its way, what arrived meanwhile, and the
// write that drains it: a later write on the file takes it over
const writing = new Map<string, { token: number; rows: Learned[] }>();
// a read newer than the page, kept for Show the latest
const latest = new Map<string, KnowledgeFileView>();
// the file page on screen; a load while its reader is on it never swaps
let onScreen: string | null = null;
let settled = false;
// the page's last query, so a move of ?line= alone reads nothing again
let lastPage: { projectId: string; fileId: string; search: string } | null =
  null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  fileTurns.clear();
  docProjects.clear();
  wrote.clear();
  writing.clear();
  latest.clear();
  settled = false;
  lastPage = null;
  docFiles.value = new Map();
});

const FILE_PAGE = /^\/projects\/[^/]+\/knowledge\/files\/([^/]+)$/;

effect(() => {
  const found = FILE_PAGE.exec(path.value);
  const id = found?.[1] === undefined ? null : decodeURIComponent(found[1]);
  if (id !== onScreen) {
    onScreen = id;
    settled = false;
  }
  // leaving the page forgets its query, so coming back reads it again;
  // the route may have recorded the new page's first
  if (lastPage?.fileId !== id) lastPage = null;
});

function forgetAux(fileId: string): void {
  fileTurns.delete(fileId);
  docProjects.delete(fileId);
  wrote.delete(fileId);
  latest.delete(fileId);
}

function setDoc(fileId: string, doc: DocFile): void {
  if (docFiles.value.get(fileId) === doc) return;
  const next = capped(docFiles.value, fileId, doc, HELD_FILES);
  for (const id of docFiles.value.keys()) {
    if (!next.has(id)) forgetAux(id);
  }
  docFiles.value = next;
}

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/knowledge`;

const filePath = (projectId: string, fileId: string) =>
  `${base(projectId)}/files/${encodeURIComponent(fileId)}`;

const frameDeleted = (row: KnowledgeFile): DocDeleted => ({
  by: row.author,
  at: row.updatedAt,
  revision: row.revision,
});

const listDeleted = (row: KnowledgeDeleted): DocDeleted => ({
  by: row.deletedBy,
  at: row.deletedAt,
  revision: row.revision,
});

// what the page learned of the file: held back while this tab writes
function learn(row: KnowledgeFile, deleted: DocDeleted | null): void {
  const waiting = writing.get(row.id);
  if (waiting !== undefined) {
    waiting.rows.push({ row, deleted });
    return;
  }
  const doc = docFiles.value.get(row.id);
  if (doc === undefined) return;
  const next = noticeRow(doc, row, deleted, wrote.get(row.id) ?? 0);
  if (next === doc) return;
  setDoc(row.id, next);
  if (deleted === null && historyHeld(row.id)) {
    void loadHistory(row.projectId, row.id, true);
  }
}

// a load of the page's file. On arrival the answer is what the page
// shows; once its reader is on it, a newer answer is a notice, and a
// failure keeps the text with the failure beside it
export async function loadDocFile(
  projectId: string,
  fileId: string,
): Promise<void> {
  const forUser = owner;
  const turn = ++seq;
  fileTurns.set(fileId, turn);
  docProjects.set(fileId, projectId);
  const held = docFiles.value.get(fileId);
  if (held === undefined || held.state === "failed") {
    setDoc(fileId, DOC_LOADING);
  }
  const current = () => owner === forUser && fileTurns.get(fileId) === turn;
  try {
    const answer = await api<KnowledgeFileDetailResponse>(
      filePath(projectId, fileId),
    );
    if (!current()) return;
    applyView(answer.file, !(settled && onScreen === fileId));
  } catch (err) {
    if (!current()) return;
    const doc = docFiles.value.get(fileId) ?? DOC_LOADING;
    if (err instanceof ApiError && err.status === 404) {
      markGone(projectId, fileId);
    } else if (doc.state === "done") {
      setDoc(fileId, { ...doc, failure: failure(err) });
    } else setDoc(fileId, { state: "failed", failure: failure(err) });
  } finally {
    if (current() && onScreen === fileId) settled = true;
  }
}

// a 404: the page held says who deleted it when the list knows, else
// the file is missing
function markGone(projectId: string, fileId: string): void {
  const doc = docFiles.value.get(fileId) ?? DOC_LOADING;
  if (doc.state === "done" && doc.deleted !== null) return;
  const row = knowledgeOf(projectId)?.deleted.find((d) => d.id === fileId);
  if (doc.state === "done" && row !== undefined) {
    setDoc(fileId, noticeRow(doc, doc.file, listDeleted(row), 0));
  } else setDoc(fileId, { state: "missing" });
}

function applyView(view: KnowledgeFileView, swap: boolean): void {
  const doc = docFiles.value.get(view.id) ?? DOC_LOADING;
  let next = takeView(doc, view, swap, wrote.get(view.id) ?? 0);
  if (next.state === "done" && next.failure !== null) {
    next = { ...next, failure: null };
  }
  if (next.state === "done" && next.file === view) latest.delete(view.id);
  else if (next.state === "done" && view.revision > next.file.revision) {
    latest.set(view.id, view);
  }
  docProjects.set(view.id, view.projectId);
  setDoc(view.id, next);
}

// the notice's Show the latest: the newer read if one is kept, else a
// read now, swapped in either way
export async function showLatest(fileId: string): Promise<void> {
  const doc = docFiles.value.get(fileId);
  if (doc?.state !== "done" || doc.deleted !== null) return;
  const kept = latest.get(fileId);
  if (
    kept !== undefined &&
    (doc.newer === null || kept.revision >= doc.newer.revision)
  ) {
    applyView(kept, true);
    return;
  }
  const forUser = owner;
  const turn = ++seq;
  fileTurns.set(fileId, turn);
  const answer = await api<KnowledgeFileDetailResponse>(
    filePath(doc.file.projectId, fileId),
  );
  if (owner === forUser && fileTurns.get(fileId) === turn) {
    applyView(answer.file, true);
  }
}

// a write from this page: what the page learns meanwhile waits, the
// answer's revision is the page's own, and the file is read again for
// its rendering before the write settles, so the page swaps once
async function write(
  projectId: string,
  fileId: string,
  send: () => Promise<KnowledgeFile>,
  text?: string,
): Promise<KnowledgeFile> {
  const forUser = owner;
  const token = ++seq;
  writing.set(fileId, { token, rows: writing.get(fileId)?.rows ?? [] });
  let gone = false;
  try {
    const row = await send();
    if (owner !== forUser) return row;
    wrote.set(fileId, Math.max(wrote.get(fileId) ?? 0, row.revision));
    fileTurns.set(fileId, ++seq);
    const doc = docFiles.value.get(fileId);
    if (doc?.state === "done") {
      // without the read, the rendering is lost, not the write: the page
      // escapes the text
      const own: KnowledgeFileView = {
        ...doc.file,
        ...row,
        text: text ?? doc.file.text,
        html: null,
        code: null,
      };
      const read = await api<KnowledgeFileDetailResponse>(
        filePath(projectId, fileId),
      ).then(
        (answer) => answer.file,
        (err: unknown) => {
          gone = err instanceof ApiError && err.status === 404;
          return own;
        },
      );
      if (owner === forUser) {
        // a write that landed after this one is theirs: a notice
        applyView(read.revision === row.revision ? read : own, true);
        if (read.revision > row.revision) {
          latest.set(fileId, read);
          writing.get(fileId)?.rows.push({ row: read, deleted: null });
        }
      }
    }
    if (historyHeld(fileId)) {
      void loadHistory(projectId, fileId, true);
    }
    return row;
  } finally {
    const waiting = writing.get(fileId);
    if (waiting?.token === token) {
      writing.delete(fileId);
      for (const { row, deleted } of waiting.rows) learn(row, deleted);
      // deleted between the write and the read, the frame missed
      if (gone && owner === forUser) markGone(projectId, fileId);
    }
  }
}

// Save from the editor with the revision it opened: the new row, and a
// stale revision is an ApiError with status 409
export function saveFile(
  projectId: string,
  fileId: string,
  text: string,
  revision: number,
): Promise<KnowledgeFile> {
  return write(
    projectId,
    fileId,
    () => replaceFile(projectId, fileId, { text, revision }),
    text,
  );
}

// Rename or move: the file keeps its id and history; a taken name and
// a stale revision are 409s in the server's words
export function renameFile(
  projectId: string,
  fileId: string,
  name: string,
  revision: number,
): Promise<KnowledgeFile> {
  return write(projectId, fileId, () =>
    renameKnowledgeFile(projectId, fileId, { name, revision }),
  );
}

// Delete from the page, which then leaves it: the page is missing, so a
// visit later draws the deleted file from the list while it loads
export async function deleteFile(
  projectId: string,
  fileId: string,
): Promise<void> {
  const forUser = owner;
  await removeFile(projectId, fileId);
  if (owner !== forUser) return;
  latest.delete(fileId);
  setDoc(fileId, { state: "missing" });
}

// Restore makes the name again from the last text, under a new id the
// page navigates to; a live file of that name is a 409
export async function restoreFile(
  projectId: string,
  fileId: string,
  name: string,
): Promise<KnowledgeFile> {
  const doc = docFiles.value.get(fileId);
  const text =
    doc?.state === "done"
      ? doc.file.text
      : (await loadDeletedText(projectId, fileId))?.text;
  if (text === undefined) throw new Error("this file kept no text");
  return addFile(projectId, { name, text });
}

// the route's first check: a click on a line number moves ?line= alone,
// and with the page's file held and current nothing is read again. The
// same query again is a load again (a reconnect), never skipped
export function onlyLineMoved(
  projectId: string,
  fileId: string,
  query: URLSearchParams,
): boolean {
  const search = query.toString();
  const last = lastPage;
  lastPage = { projectId, fileId, search };
  if (
    last === null ||
    last.projectId !== projectId ||
    last.fileId !== fileId ||
    last.search === search ||
    !sameBesidesLine(last.search, search)
  ) {
    return false;
  }
  const doc = docFileOf(fileId);
  return doc.state === "done" && doc.failure === null;
}

// the file page's route: the list and the file side by side, then what
// the query opens, and for a file gone its last text
export async function loadDocPage(
  projectId: string,
  fileId: string,
  query: URLSearchParams,
): Promise<void> {
  const revision = revisionParam(query.get("revision"));
  await Promise.all([
    loadKnowledge(projectId),
    loadDocFile(projectId, fileId),
    revision !== null
      ? loadRevision(projectId, fileId, revision)
      : query.has("history")
        ? loadHistory(projectId, fileId, true)
        : null,
  ]);
  const gone = knowledgeOf(projectId)?.deleted.some((d) => d.id === fileId);
  if (docFileOf(fileId).state === "missing" && gone === true) {
    await loadDeletedText(projectId, fileId);
  }
}

// the list moves on a frame, a load or a write: a row newer than a
// page, or the page's file in the Deleted rows, is what it learns. The
// pages are read untracked, so only the list runs this again
effect(() => {
  const held = lists.value;
  untracked(() => {
    const docs = docFiles.value;
    batch(() => {
      for (const [fileId, doc] of docs) {
        if (doc.state !== "done") continue;
        const list = held.get(doc.file.projectId);
        if (list === undefined) continue;
        const gone = list.deleted.find((row) => row.id === fileId);
        const live = list.files.find((row) => row.id === fileId);
        if (live !== undefined) learn(live, null);
        else if (gone !== undefined) learn(gone, listDeleted(gone));
      }
    });
  });
});

// the pages of a project, by what they said last
const pagesOf = (projectId: string) =>
  [...docProjects].flatMap(([fileId, project]) =>
    project === projectId ? [fileId] : [],
  );

// a bin emptied: an open deleted page has no text left, so it is
// missing, and the deleted files' histories hold nothing
function emptied(projectId: string): void {
  const gone = new Set(
    pagesOf(projectId).filter((fileId) => {
      const doc = docFiles.value.get(fileId);
      return (
        doc?.state === "missing" ||
        (doc?.state === "done" && doc.deleted !== null)
      );
    }),
  );
  batch(() => {
    for (const fileId of gone) {
      latest.delete(fileId);
      setDoc(fileId, { state: "missing" });
    }
    forgetHistories(projectId, (fileId) => gone.has(fileId));
  });
}

// a project no longer seen: nothing of its pages stays
function revoked(projectId: string): void {
  const ids = pagesOf(projectId);
  if (lastPage?.projectId === projectId) lastPage = null;
  if (ids.length === 0) return;
  const next = new Map(docFiles.value);
  for (const fileId of ids) {
    next.delete(fileId);
    forgetAux(fileId);
    writing.delete(fileId);
  }
  docFiles.value = next;
}

// for the tests: the maps beside the pages stay bounded with them
export const heldSizes = () => ({
  docs: docFiles.value.size,
  turns: fileTurns.size,
  projects: docProjects.size,
  wrote: wrote.size,
  latest: latest.size,
});

export function onDocSocket(ev: SocketEvent): void {
  if (ev.type === "knowledge") {
    learn(ev.file, ev.deleted ? frameDeleted(ev.file) : null);
  } else if (ev.type === "knowledgeEmptied") emptied(ev.projectId);
  else if (ev.type === "revoked") revoked(ev.projectId);
}

onSocketEvent(onDocSocket);
