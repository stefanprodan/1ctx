// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the transcript's scroll box at one scroll event
export type Box = { top: number; height: number; client: number };

// a view near its end follows it; only the user scrolling up lets go
export function following(stick: boolean, prev: Box, next: Box): boolean {
  // rows that shrink and a box that grows (a phone's keyboard closing)
  // clamp scrollTop without anyone scrolling
  if (
    next.top < prev.top - 1 &&
    next.height >= prev.height &&
    next.client <= prev.client
  ) {
    return false;
  }
  if (next.height - next.top - next.client < 40) return true;
  return stick;
}
