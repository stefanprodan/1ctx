// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A phone's keyboard shrinks only the visual viewport, and the browser
// scrolls the page to show the field. The shell takes the visible
// height instead, so the page has nothing to scroll and its top stays.

export type View = { height: number; scale: number; pageTop: number };

export type Frame = {
  // the shell's height in px, null for the whole layout viewport
  height: number | null;
  // how far down the page the visible area starts, where the shell is
  // moved to until the page is back at its top
  top: number;
};

// a pinch zoom shrinks the visual viewport too, and the layout must not
// follow it
const ZOOMED = 1.01;

// the page head (56) and a one-line composer (about 120) with a line of
// the transcript between; a phone on its side with the keyboard up has
// about 60, and there the browser scrolls the field into view instead
export const MIN_SHELL = 200;

const WHOLE: Frame = { height: null, top: 0 };

export function frameOf(layoutHeight: number, view: View): Frame {
  if (view.scale > ZOOMED) return WHOLE;
  if (layoutHeight - view.height <= 1) return WHOLE;
  if (view.height < MIN_SHELL) return WHOLE;
  return { height: view.height, top: Math.max(0, view.pageTop) };
}
