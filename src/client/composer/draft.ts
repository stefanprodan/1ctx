// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What is in the composer survives a navigation and a reload: one
// draft per chat, and one per place a chat is started from, in
// localStorage under the signed-in user, so a shared browser never
// hands one person another's words. A draft is its text and the staged
// files and images added to it, each with the project it was staged in, since
// Home's draft stays while its project changes, and the edit of a
// waiting message when one is open. Storage can be absent or full, so
// every access is guarded and a failure loses nothing but the draft.

// the name is kept so a file whose lease ran out can still be named
export type DraftUpload = { projectId: string; id: string; name: string };
// a staged image, kept the same way; absent from a draft without one
export type DraftImage = DraftUpload;
// a waiting message open for an edit: the draft's text is its new text,
// and the text set aside until Save or Cancel is before, so a reload
// keeps the edit and never turns its text into a message of its own
export type DraftEdit = { id: string; revision: number; before: string };
export type Draft = {
  text: string;
  uploads: DraftUpload[];
  images?: DraftImage[];
  edit?: DraftEdit;
};

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

const isEdit = (value: unknown): value is DraftEdit =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DraftEdit).id === "string" &&
  typeof (value as DraftEdit).revision === "number" &&
  typeof (value as DraftEdit).before === "string";

export function readDraft(key: string): Draft {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return EMPTY_DRAFT;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_DRAFT;
    const { text, uploads, images, edit } = value as {
      text?: unknown;
      uploads?: unknown;
      images?: unknown;
      edit?: unknown;
    };
    const kept = Array.isArray(images) ? images.filter(isUpload) : [];
    return {
      text: typeof text === "string" ? text : "",
      uploads: Array.isArray(uploads) ? uploads.filter(isUpload) : [],
      ...(kept.length > 0 ? { images: kept } : {}),
      ...(isEdit(edit) ? { edit } : {}),
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function writeDraft(key: string, draft: Draft): void {
  try {
    if (
      draft.text === "" &&
      draft.uploads.length === 0 &&
      (draft.images ?? []).length === 0 &&
      draft.edit === undefined
    ) {
      localStorage.removeItem(key);
    } else {
      const { images, ...rest } = draft;
      localStorage.setItem(
        key,
        JSON.stringify(images?.length ? { ...rest, images } : rest),
      );
    }
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

export function writeDraftImages(key: string, images: DraftImage[]): void {
  writeDraft(key, { ...readDraft(key), images });
}

// an edit opened with its text, or closed with the text the box then
// holds; the files and images stay as they are
export function writeDraftEdit(
  key: string,
  text: string,
  edit: DraftEdit | undefined,
): void {
  const { uploads, images } = readDraft(key);
  writeDraft(key, {
    text,
    uploads,
    ...(images === undefined ? {} : { images }),
    ...(edit === undefined ? {} : { edit }),
  });
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

export function dropDraftImages(key: string, ids: readonly string[]): void {
  const draft = readDraft(key);
  writeDraft(key, {
    ...draft,
    images: (draft.images ?? []).filter((image) => !ids.includes(image.id)),
  });
}
