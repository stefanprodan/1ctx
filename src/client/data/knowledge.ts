// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge entity: a project's list of files, held once its tab
// reads it and dropped with the signed-in user, and the calls that
// change it. The list travels without the texts, so a file's text, its
// versions and a version's text are read on open and kept beside it. A
// write keeps the row the server answered, and a knowledge frame from a
// run applies straight to the list by revision, so an open tab follows
// what an agent writes without asking again.

import { batch, effect, signal } from "@preact/signals";
import type {
  CreateKnowledgeFileRequest,
  EmptyBinResponse,
  KnowledgeFileDetailResponse,
  KnowledgeFileResponse,
  KnowledgeListResponse,
  KnowledgeVersionDetailResponse,
  KnowledgeVersionsResponse,
  RenameKnowledgeFileRequest,
  ReplaceKnowledgeFileRequest,
} from "../../shared/api/knowledge.ts";
import type {
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeList,
  KnowledgeTotals,
  KnowledgeUploadResult,
  KnowledgeVersion,
} from "../../shared/contracts/knowledge.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api, upload } from "./api.ts";
import { capped } from "./knowledge-rows.ts";
import { me } from "./me.ts";
import { project } from "./projects.ts";
import { onSocketEvent } from "./socket.ts";

// the projects whose lists are held, the least recent dropped past it
const HELD_LISTS = 16;

// the list by project id, the texts and the versions by file id, and a
// version's text by version id
export const lists = signal<ReadonlyMap<string, KnowledgeList>>(new Map());
export const listErrors = signal<ReadonlyMap<string, Failure>>(new Map());
export const fileTexts = signal<Record<string, string>>({});
export const fileVersions = signal<Record<string, KnowledgeVersion[]>>({});
export const versionTexts = signal<Record<string, string>>({});

let owner: string | null = null;
// the latest word wanted per project: a write and a frame bump it, so
// an answer to a load they overtook is dropped
const turns = new Map<string, number>();

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turns.clear();
  lists.value = new Map();
  listErrors.value = new Map();
  fileTexts.value = {};
  fileVersions.value = {};
  versionTexts.value = {};
});

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/knowledge`;

const filePath = (projectId: string, fileId: string) =>
  `${base(projectId)}/files/${encodeURIComponent(fileId)}`;

export function knowledgeOf(projectId: string): KnowledgeList | null {
  return lists.value.get(projectId) ?? null;
}

// the tab's count: the list once it is held, else what the project row
// said, and null while neither is known
export function knowledgeCount(projectId: string): number | null {
  const list = lists.value.get(projectId);
  if (list !== undefined) return list.files.length;
  const row = project.value;
  return row !== null && row.id === projectId ? row.knowledge.files : null;
}

export function totalsOf(files: readonly KnowledgeFile[]): KnowledgeTotals {
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    tokens: files.reduce((sum, file) => sum + file.tokens, 0),
  };
}

const byName = (files: readonly KnowledgeFile[]) =>
  files.slice().sort((a, b) => a.name.localeCompare(b.name));

const byDeleted = (files: readonly KnowledgeDeleted[]) =>
  files.slice().sort((a, b) => b.deletedAt - a.deletedAt);

// the list as the page reads it: the files by name, the deleted newest
// first, and the totals of the rows held. A name made again under a new
// id is live, not deleted, as the server's list says, so a frame or an
// add that brings it back takes it out of the Deleted card
function shape(list: KnowledgeList): KnowledgeList {
  const files = byName(list.files);
  const live = new Set(files.map((file) => file.name));
  return {
    files,
    deleted: byDeleted(list.deleted.filter((file) => !live.has(file.name))),
    totals: totalsOf(files),
    limits: list.limits,
  };
}

function put(projectId: string, list: KnowledgeList): void {
  const shaped = shape(list);
  const held = lists.value.get(projectId);
  batch(() => {
    if (held !== undefined) {
      const revisions = new Map(
        [...shaped.files, ...shaped.deleted].map((file) => [
          file.id,
          file.revision,
        ]),
      );
      for (const file of [...held.files, ...held.deleted]) {
        if (revisions.get(file.id) !== file.revision) dropCached(file.id);
      }
    }
    const next = capped(lists.value, projectId, shaped, HELD_LISTS);
    for (const [id, list] of lists.value) {
      if (!next.has(id)) dropFilesOf(list);
    }
    lists.value = next;
    if (listErrors.value.has(projectId)) {
      const errors = new Map(listErrors.value);
      errors.delete(projectId);
      listErrors.value = errors;
    }
  });
}

function dropFilesOf(list: KnowledgeList): void {
  for (const file of [...list.files, ...list.deleted]) dropCached(file.id);
}

// a project gone from view, or a load of it failed: nothing of it stays
function dropList(projectId: string): void {
  const held = lists.value.get(projectId);
  if (held === undefined) return;
  batch(() => {
    dropFilesOf(held);
    const next = new Map(lists.value);
    next.delete(projectId);
    lists.value = next;
  });
}

// what was read of a file is stale the moment it is written or deleted
function dropCached(fileId: string): void {
  if (fileId in fileTexts.value) {
    const texts = { ...fileTexts.value };
    delete texts[fileId];
    fileTexts.value = texts;
  }
  if (fileId in fileVersions.value) {
    const held = { ...fileVersions.value };
    delete held[fileId];
    fileVersions.value = held;
  }
}

function revisionOf(projectId: string, fileId: string): number | undefined {
  const held = lists.value.get(projectId);
  return (
    held?.files.find((file) => file.id === fileId) ??
    held?.deleted.find((file) => file.id === fileId)
  )?.revision;
}

const bump = (projectId: string) => {
  turns.set(projectId, (turns.get(projectId) ?? 0) + 1);
};

// a load's answer is kept only when it is still the one wanted: for the
// signed-in user of the moment and the latest word on the project
export async function loadKnowledge(projectId: string): Promise<void> {
  const forUser = owner;
  const mine = (turns.get(projectId) ?? 0) + 1;
  turns.set(projectId, mine);
  try {
    const list = await api<KnowledgeListResponse>(base(projectId));
    if (owner === forUser && turns.get(projectId) === mine) {
      put(projectId, list);
    }
  } catch (err) {
    if (owner === forUser && turns.get(projectId) === mine) {
      batch(() => {
        dropList(projectId);
        const errors = new Map(listErrors.value);
        errors.set(projectId, failure(err));
        listErrors.value = errors;
      });
    }
  }
}

// the row the server answered, into the list held, unless a frame
// already brought a later revision of it, a delete included
function keepFile(projectId: string, file: KnowledgeFile): void {
  const held = lists.value.get(projectId);
  if (held === undefined) return;
  const seen =
    held.files.find((row) => row.id === file.id) ??
    held.deleted.find((row) => row.id === file.id);
  if (seen !== undefined && seen.revision >= file.revision) return;
  put(projectId, {
    ...held,
    files: [...held.files.filter((row) => row.id !== file.id), file],
    deleted: held.deleted.filter((row) => row.id !== file.id),
  });
}

// the file's text, read once per open and kept; a read a write overtook
// keeps nothing, since the write's word is the fresher one
export async function readFile(
  projectId: string,
  fileId: string,
): Promise<string> {
  const held = fileTexts.value[fileId];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = turns.get(projectId) ?? 0;
  const revision = revisionOf(projectId, fileId);
  const answer = await api<KnowledgeFileDetailResponse>(
    filePath(projectId, fileId),
  );
  if (
    owner === forUser &&
    turns.get(projectId) === mine &&
    revisionOf(projectId, fileId) === revision
  ) {
    fileTexts.value = { ...fileTexts.value, [fileId]: answer.file.text };
  }
  return answer.file.text;
}

export async function loadVersions(
  projectId: string,
  fileId: string,
): Promise<KnowledgeVersion[]> {
  const held = fileVersions.value[fileId];
  if (held !== undefined) return held;
  const forUser = owner;
  const mine = turns.get(projectId) ?? 0;
  const revision = revisionOf(projectId, fileId);
  const answer = await api<KnowledgeVersionsResponse>(
    `${filePath(projectId, fileId)}/versions`,
  );
  if (
    owner === forUser &&
    turns.get(projectId) === mine &&
    revisionOf(projectId, fileId) === revision
  ) {
    fileVersions.value = { ...fileVersions.value, [fileId]: answer.versions };
  }
  return answer.versions;
}

// a version's text never changes, so it is kept for the tab's life
export async function readVersion(
  projectId: string,
  versionId: string,
): Promise<string> {
  const held = versionTexts.value[versionId];
  if (held !== undefined) return held;
  const forUser = owner;
  const answer = await api<KnowledgeVersionDetailResponse>(
    `${base(projectId)}/versions/${encodeURIComponent(versionId)}`,
  );
  if (owner === forUser) {
    versionTexts.value = {
      ...versionTexts.value,
      [versionId]: answer.version.text,
    };
  }
  return answer.version.text;
}

export async function addFile(
  projectId: string,
  body: CreateKnowledgeFileRequest,
): Promise<KnowledgeFile> {
  const forUser = owner;
  const answer = await api<KnowledgeFileResponse>(
    base(projectId),
    "POST",
    body,
  );
  if (owner === forUser) {
    bump(projectId);
    keepFile(projectId, answer.file);
  }
  return answer.file;
}

export function uploadFile(
  projectId: string,
  file: File,
  folder: string,
  options: {
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<KnowledgeUploadResult> {
  const query = new URLSearchParams({ folder, name: file.name });
  return upload<KnowledgeUploadResult>(
    `${base(projectId)}/upload?${query}`,
    file,
    options,
  );
}

export async function replaceFile(
  projectId: string,
  fileId: string,
  body: ReplaceKnowledgeFileRequest,
): Promise<KnowledgeFile> {
  const forUser = owner;
  const answer = await api<KnowledgeFileResponse>(
    filePath(projectId, fileId),
    "PUT",
    body,
  );
  wrote(projectId, answer.file, forUser);
  return answer.file;
}

// a rename is a write like a replace: the row keeps its id and moves to
// its new name in the list
export async function renameKnowledgeFile(
  projectId: string,
  fileId: string,
  body: RenameKnowledgeFileRequest,
): Promise<KnowledgeFile> {
  const forUser = owner;
  const answer = await api<KnowledgeFileResponse>(
    filePath(projectId, fileId),
    "PATCH",
    body,
  );
  wrote(projectId, answer.file, forUser);
  return answer.file;
}

// an answer for a user no longer signed in touches nothing of the next
function wrote(projectId: string, file: KnowledgeFile, forUser: string | null) {
  if (owner !== forUser) return;
  bump(projectId);
  dropCached(file.id);
  keepFile(projectId, file);
}

// the row goes from the list at once; who deleted it and when come with
// the frame, which is what puts it in the Deleted card
export async function removeFile(
  projectId: string,
  fileId: string,
): Promise<void> {
  const forUser = owner;
  await api(filePath(projectId, fileId), "DELETE");
  if (owner !== forUser) return;
  bump(projectId);
  dropCached(fileId);
  const held = lists.value.get(projectId);
  if (held === undefined) return;
  put(projectId, {
    ...held,
    files: held.files.filter((row) => row.id !== fileId),
  });
}

export async function emptyBin(projectId: string): Promise<number> {
  const forUser = owner;
  const answer = await api<EmptyBinResponse>(
    `${base(projectId)}/deleted`,
    "DELETE",
  );
  if (owner === forUser) forgetDeleted(projectId);
  return answer.files;
}

// the Deleted card's rows go; their text and versions go with them
function forgetDeleted(projectId: string): void {
  const held = lists.value.get(projectId);
  if (held === undefined) return;
  bump(projectId);
  for (const file of held.deleted) dropCached(file.id);
  put(projectId, { ...held, deleted: [] });
}

// a write from a run or another tab: the row replaces the one held when
// it is newer, or joins the list when it is unknown, and a delete moves
// it to the Deleted card. Nothing is fetched, and a list in flight is
// dropped, so a stale answer never brings a deleted file back.
export function applyKnowledge(
  projectId: string,
  file: KnowledgeFile,
  deleted: boolean,
): void {
  const held = lists.value.get(projectId);
  if (held === undefined) return;
  const seen =
    held.files.find((row) => row.id === file.id) ??
    held.deleted.find((row) => row.id === file.id);
  if (seen !== undefined && seen.revision >= file.revision) return;
  bump(projectId);
  dropCached(file.id);
  put(projectId, {
    ...held,
    files: deleted
      ? held.files.filter((row) => row.id !== file.id)
      : [...held.files.filter((row) => row.id !== file.id), file],
    deleted: [
      ...held.deleted.filter((row) => row.id !== file.id),
      ...(deleted
        ? [{ ...file, deletedBy: file.author, deletedAt: file.updatedAt }]
        : []),
    ],
  });
}

export function onKnowledgeSocket(ev: SocketEvent): void {
  if (ev.type === "revoked") {
    bump(ev.projectId);
    batch(() => {
      dropList(ev.projectId);
      if (listErrors.value.has(ev.projectId)) {
        const errors = new Map(listErrors.value);
        errors.delete(ev.projectId);
        listErrors.value = errors;
      }
    });
    return;
  }
  if (ev.type === "knowledgeEmptied") {
    forgetDeleted(ev.projectId);
    return;
  }
  if (ev.type !== "knowledge") return;
  applyKnowledge(ev.projectId, ev.file, ev.deleted);
}

onSocketEvent(onKnowledgeSocket);
