// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Markup read by its owners' classes: how many elements carry a class,
// whatever else their class list holds and in whatever order, so a test
// names what it means and survives a class added beside it.

// the elements whose class list holds every one of the names
export function withClass(html: string, ...names: string[]): number {
  let n = 0;
  for (const [, list] of html.matchAll(/class="([^"]*)"/g)) {
    const own = new Set(list!.split(" "));
    if (names.every((name) => own.has(name))) n++;
  }
  return n;
}
