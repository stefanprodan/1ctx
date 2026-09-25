// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the knowledge pages keep in this browser, under the signed-in
// user so a shared browser never hands one person another's: an
// unsaved edit per file, and per project and folder for a new file, and
// which folders of a project's tree are open. Storage can be absent or
// full, so every access is guarded and a failure loses only the
// convenience.

import { effect, signal } from "@preact/signals";
import { withParents } from "./knowledge-rows.ts";
import { me } from "./me.ts";

// the text, the revision it was based on (null for a new file) and
// when it was last kept; a new file's draft keeps its path too
export type KnowledgeDraft = {
  text: string;
  revision: number | null;
  savedAt: number;
  name?: string;
};

export type DraftScope =
  | { fileId: string }
  | { projectId: string; folder: string };

export const DRAFT_PAUSE_MS = 400;

export const knowledgeDraftKey = (userId: string, scope: DraftScope) =>
  "fileId" in scope
    ? `knowledge-draft:${userId}:file:${scope.fileId}`
    : `knowledge-draft:${userId}:new:${scope.projectId}:${scope.folder}`;

export const openFoldersKey = (userId: string, projectId: string) =>
  `knowledge-open:${userId}:${projectId}`;

export function parseDraft(raw: string | null): KnowledgeDraft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { text, revision, savedAt, name } = value as Record<string, unknown>;
    if (typeof text !== "string" || typeof savedAt !== "number") return null;
    return {
      text,
      revision: typeof revision === "number" ? revision : null,
      savedAt,
      ...(typeof name === "string" ? { name } : {}),
    };
  } catch {
    return null;
  }
}

// a draft made on an older revision is still offered; the page says the
// file changed since
export const draftBehind = (draft: KnowledgeDraft, revision: number): boolean =>
  draft.revision !== null && draft.revision < revision;

// bumped on every keep and drop, so a page reading a draft draws again
const tick = signal(0);
// the writes waiting for the pause, by key
const pending = new Map<
  string,
  { draft: KnowledgeDraft; timer: ReturnType<typeof setTimeout> }
>();

const userId = () => me.value?.id ?? null;

function store(key: string, draft: KnowledgeDraft | null): void {
  try {
    if (draft === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // nothing to do: the draft is a convenience
  }
}

export function draftOf(scope: DraftScope): KnowledgeDraft | null {
  void tick.value;
  const user = userId();
  if (user === null) return null;
  const key = knowledgeDraftKey(user, scope);
  const waiting = pending.get(key);
  if (waiting !== undefined) return waiting.draft;
  try {
    return parseDraft(localStorage.getItem(key));
  } catch {
    return null;
  }
}

// a new file with neither text nor path is no draft; an edit that
// empties a file is one
const isEmpty = (draft: KnowledgeDraft) =>
  draft.revision === null && draft.text === "" && !draft.name;

// kept after a pause in typing
export function keepDraft(
  scope: DraftScope,
  text: string,
  revision: number | null,
  name?: string,
): void {
  const user = userId();
  if (user === null) return;
  const key = knowledgeDraftKey(user, scope);
  const draft: KnowledgeDraft = {
    text,
    revision,
    savedAt: Date.now(),
    ...(name === undefined ? {} : { name }),
  };
  clearTimeout(pending.get(key)?.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    store(key, isEmpty(draft) ? null : draft);
  }, DRAFT_PAUSE_MS);
  pending.set(key, { draft, timer });
  tick.value++;
}

export function dropDraft(scope: DraftScope): void {
  const user = userId();
  if (user === null) return;
  const key = knowledgeDraftKey(user, scope);
  clearTimeout(pending.get(key)?.timer);
  pending.delete(key);
  store(key, null);
  tick.value++;
}

// a page left in the pause writes its draft now
export function flushDrafts(): void {
  for (const [key, { draft, timer }] of pending) {
    clearTimeout(timer);
    store(key, isEmpty(draft) ? null : draft);
  }
  pending.clear();
}

// the open folders of the tree, per project for the user of the moment
export const openFolders = signal<ReadonlyMap<string, ReadonlySet<string>>>(
  new Map(),
);

let owner: string | null = null;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  flushDrafts();
  owner = id;
  openFolders.value = new Map();
});

function readFolders(user: string, projectId: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(openFoldersKey(user, projectId));
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

// read once per project from storage, then from the signal
export function openFoldersOf(projectId: string): ReadonlySet<string> {
  const held = openFolders.value.get(projectId);
  if (held !== undefined) return held;
  const user = userId();
  return user === null ? new Set() : readFolders(user, projectId);
}

function putFolders(projectId: string, folders: ReadonlySet<string>): void {
  const user = userId();
  if (user === null) return;
  const next = new Map(openFolders.value);
  next.set(projectId, folders);
  openFolders.value = next;
  try {
    const key = openFoldersKey(user, projectId);
    if (folders.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...folders].sort()));
  } catch {
    // the tree opens closed next time
  }
}

export function toggleFolder(projectId: string, folder: string): void {
  const folders = new Set(openFoldersOf(projectId));
  if (folders.has(folder)) folders.delete(folder);
  else folders.add(folder);
  putFolders(projectId, folders);
}

// a crumb's link to a folder (?folder=plans/x) opens it and its parents,
// a lone one the user closed (its path marked with !) included
export function openFolder(projectId: string, folder: string): void {
  const held = openFoldersOf(projectId);
  const wanted = withParents(folder);
  const closed = wanted.map((path) => `!${path}`);
  if (
    wanted.every((path) => held.has(path)) &&
    closed.every((path) => !held.has(path))
  ) {
    return;
  }
  putFolders(
    projectId,
    new Set([...[...held].filter((path) => !closed.includes(path)), ...wanted]),
  );
}
