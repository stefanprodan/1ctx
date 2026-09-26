// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What is in the composer survives a navigation and a reload: one
// draft per chat, and one per place a chat is started from, in
// localStorage under the signed-in user, so a shared browser never
// hands one person another's words. A draft is its text and the staged
// files added to it, each with the project it was staged in, since
// Home's draft stays while its project changes. Storage can be absent
// or full, so every access is guarded and a failure loses nothing but
// the draft.

// the name is kept so a file whose lease ran out can still be named
export type DraftUpload = { projectId: string; id: string; name: string };
export type Draft = { text: string; uploads: DraftUpload[] };

export const EMPTY_DRAFT: Draft = { text: "", uploads: [] };

// a chat's draft, or a new chat's in a project
export type Scope = { sessionId: string } | { projectId: string };

export const draftKey = (userId: string, scope: Scope) =>
  "sessionId" in scope
    ? `draft:${userId}:chat:${scope.sessionId}`
    : `draft:${userId}:project:${scope.projectId}`;

const isUpload = (value: unknown): value is DraftUpload =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DraftUpload).projectId === "string" &&
  typeof (value as DraftUpload).id === "string" &&
  typeof (value as DraftUpload).name === "string";

export function readDraft(key: string): Draft {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return EMPTY_DRAFT;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_DRAFT;
    const { text, uploads } = value as { text?: unknown; uploads?: unknown };
    return {
      text: typeof text === "string" ? text : "",
      uploads: Array.isArray(uploads) ? uploads.filter(isUpload) : [],
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function writeDraft(key: string, draft: Draft): void {
  try {
    if (draft.text === "" && draft.uploads.length === 0) {
      localStorage.removeItem(key);
    } else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // nothing to do: the draft is a convenience
  }
}

// one half written, the other kept as it is stored
export function writeDraftText(key: string, text: string): void {
  writeDraft(key, { ...readDraft(key), text });
}

export function writeDraftUploads(key: string, uploads: DraftUpload[]): void {
  writeDraft(key, { ...readDraft(key), uploads });
}

// a send claimed these: they leave the draft as it is stored now, which
// may be newer than what the composer that sent them last wrote
export function dropDraftUploads(key: string, ids: readonly string[]): void {
  const draft = readDraft(key);
  writeDraft(key, {
    ...draft,
    uploads: draft.uploads.filter((upload) => !ids.includes(upload.id)),
  });
}
