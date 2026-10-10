// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the chip's gap to its menu, and the menu's to the edge of the room
const GAP = 6;
const EDGE = 8;
// many agents scroll inside the menu
export const MENU_MAX = 290;

export type MenuPlace = { up: boolean; maxHeight: number };

// the menu opens below its chip when it fits there, else on the side
// with more room, and scrolls past that room; `top` is the page head's
// bottom, `bottom` what the window shows, both in the window's numbers
export function menuPlace({
  chip,
  top,
  bottom,
  height,
}: {
  chip: { top: number; bottom: number };
  top: number;
  bottom: number;
  // the menu's whole list
  height: number;
}): MenuPlace {
  const below = bottom - chip.bottom - GAP - EDGE;
  const above = chip.top - top - GAP - EDGE;
  const up = Math.min(height, MENU_MAX) > below && above > below;
  return {
    up,
    maxHeight: Math.max(0, Math.min(MENU_MAX, up ? above : below)),
  };
}
