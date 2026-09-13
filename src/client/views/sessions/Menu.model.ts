// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat menu's state without a DOM: closed, open, asking to delete,
// deleting, or failed. Closing forgets the question and the failure;
// nothing closes or gives up while a delete is on its way.

export type MenuState = {
  open: boolean;
  asking: boolean;
  busy: boolean;
  failure: string | null;
};

export type MenuAction =
  | "toggle"
  | "dismiss"
  | "ask"
  | "keep"
  | "start"
  | { failed: string };

export const CLOSED: MenuState = {
  open: false,
  asking: false,
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
    case "ask":
      return { ...state, asking: true, failure: null };
    case "keep":
      return state.busy ? state : { ...state, asking: false, failure: null };
    case "start":
      return { ...state, busy: true, failure: null };
  }
}
