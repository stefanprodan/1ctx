// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat menu's state without a DOM: closed, open, asking to delete
// or to archive, on its way, editing the title, or failed. Closing
// forgets the question and the failure; nothing closes or gives up
// while a delete, an archive or a rename is on its way. Editing
// replaces the title with a box: the menu is shut, Enter saves and
// Escape or a blur gives the title back.

export type MenuAsk = "delete" | "archive";

type MenuState = {
  open: boolean;
  // the action the menu asks about, null while it lists the items
  asking: MenuAsk | null;
  editing: boolean;
  busy: boolean;
  failure: string | null;
};

export type MenuAction =
  | "toggle"
  | "dismiss"
  | { ask: MenuAsk }
  | "keep"
  | "edit"
  | "start"
  | "saved"
  | { failed: string };

export const CLOSED: MenuState = {
  open: false,
  asking: null,
  editing: false,
  busy: false,
  failure: null,
};

export function menuStep(state: MenuState, action: MenuAction): MenuState {
  if (typeof action === "object") {
    if ("ask" in action) {
      return { ...state, asking: action.ask, failure: null };
    }
    return { ...state, busy: false, failure: action.failed };
  }
  switch (action) {
    case "toggle":
      if (state.busy) return state;
      return state.open ? CLOSED : { ...CLOSED, open: true };
    case "dismiss":
      return state.busy ? state : CLOSED;
    case "edit":
      return state.busy ? state : { ...CLOSED, editing: true };
    case "saved":
      return CLOSED;
    case "keep":
      return state.busy ? state : { ...state, asking: null, failure: null };
    case "start":
      return { ...state, busy: true, failure: null };
  }
}

// The items past Download: every member archives a chat, the owner and
// an admin also rename and delete it. An archived chat keeps only
// Delete, and a run, read-only once it ends, is never archived or
// renamed.
export function menuItems(chat: {
  run: boolean;
  archived: boolean;
  manage: boolean;
}): { rename: boolean; archive: boolean; delete: boolean } {
  const live = !chat.run && !chat.archived;
  return {
    rename: live && chat.manage,
    archive: live,
    delete: chat.manage,
  };
}
