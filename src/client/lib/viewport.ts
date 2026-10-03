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
  toTop: boolean;
};

// a pinch zoom shrinks the visual viewport too, and the layout must not
// follow it
const ZOOMED = 1.01;

export function frameOf(layoutHeight: number, view: View): Frame {
  if (view.scale > ZOOMED) return { height: null, toTop: false };
  const covered = layoutHeight - view.height > 1;
  return {
    height: covered ? Math.max(0, view.height) : null,
    toTop: view.pageTop > 0,
  };
}
