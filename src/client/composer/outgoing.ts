// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a send carries, and whether it may go now, apart from the view
// so the rule is tested without a DOM: Enter and Send read the same.

export type Staging = { readonly ids: string[]; readonly busy: boolean };

// null while it may not go: a blank text goes only with images, and a
// draft whose items go with it waits while any uploads or is checked,
// or before the staged items of its project are known. carries is
// false for a command, which takes no files and waits on none
export function outgoing(draft: {
  text: string;
  files: Staging;
  images: Staging;
  ready: boolean;
  placed: boolean;
  carries: boolean;
}): { uploads: string[]; images: string[] } | null {
  const { files, images, carries } = draft;
  if (draft.text.trim() === "" && images.ids.length === 0) return null;
  if (!draft.ready) return null;
  if (!carries) return { uploads: [], images: [] };
  if (!draft.placed || files.busy || images.busy) return null;
  return { uploads: files.ids, images: images.ids };
}
