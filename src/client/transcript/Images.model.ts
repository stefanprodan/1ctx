// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The size a message's image is drawn at: its own, fitted inside a
// square box without enlarging, so the row has its height before the
// bytes arrive and nothing under it jumps.

// the long side on a message, in CSS pixels; a phone's narrower column
// shrinks it further by its stylesheet
export const IMAGE_BOX = 320;

export const FREED_LINE = "Image removed to free space";

export function fitBox(
  width: number,
  height: number,
  box = IMAGE_BOX,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: box, height: box };
  const scale = Math.min(1, box / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
