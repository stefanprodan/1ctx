// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The text in the composer survives a navigation and a reload: one
// draft per chat, and one per project for the chat not started yet,
// in localStorage. Storage can be absent or full, so every access is
// guarded and a failure loses nothing but the draft.

export const draftKey = (
  scope: { sessionId: string } | { projectId: string },
) =>
  "sessionId" in scope
    ? `draft:chat:${scope.sessionId}`
    : `draft:project:${scope.projectId}`;

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text === "") localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    // nothing to do: the draft is a convenience
  }
}
