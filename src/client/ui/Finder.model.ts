// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the page head's gutter on a phone
const GUTTER = 16;

export type Place = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

type Box = { top: number; bottom: number; left: number; right: number };

// the panel under its button, kept inside the window; the numbers are
// the window's, and `frame` is where the panel's fixed frame starts in
// it (a moved shell's corner, else 0, 0)
export function placeOf({
  button,
  frame,
  view,
  width: wanted,
  align,
}: {
  button: Box;
  frame: { top: number; left: number };
  // the window's width and the bottom of what is visible in it
  view: { width: number; height: number };
  // null takes the whole room
  width: number | null;
  align: "left" | "right";
}): Place {
  const room = view.width - 2 * GUTTER;
  const width = wanted === null ? room : Math.min(wanted, room);
  const left = align === "right" ? button.right - width : button.left;
  const top = button.bottom + 4;
  return {
    top: top - frame.top,
    left:
      Math.max(GUTTER, Math.min(left, view.width - GUTTER - width)) -
      frame.left,
    width,
    maxHeight: Math.max(160, Math.min(360, view.height - top - GUTTER)),
  };
}
