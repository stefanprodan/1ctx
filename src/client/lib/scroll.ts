// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The nearest ancestor that scrolls: the shell's main column, for
// anything that follows or reacts to the page's scroll.

export function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}
