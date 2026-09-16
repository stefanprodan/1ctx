// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat menu's state without a DOM: closed, open, asking to delete,
// deleting, editing the title, or failed. Closing forgets the question
// and the failure; nothing closes or gives up while a delete or a
// rename is on its way. Editing replaces the title with a box: the
// menu is shut, Enter saves and Escape or a blur gives the title back.

export type MenuState = {
  open: boolean;
  asking: boolean;
  editing: boolean;
  busy: boolean;
  failure: string | null;
};

export type MenuAction =
  | "toggle"
  | "dismiss"
  | "ask"
  | "keep"
  | "edit"
  | "start"
  | "saved"
  | { failed: string };

export const CLOSED: MenuState = {
  open: false,
  asking: false,
  editing: false,
  busy: false,
  failure: null,
};

export function menuStep(state: MenuState, action: MenuAction): MenuState {
  if (typeof action === "object") {
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
    case "ask":
      return { ...state, asking: true, failure: null };
    case "keep":
      return state.busy ? state : { ...state, asking: false, failure: null };
    case "start":
      return { ...state, busy: true, failure: null };
  }
}
