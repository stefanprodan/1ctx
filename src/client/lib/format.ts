// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Small pure formatters the views share.

// the avatar letters: the first letter of the first two words, or the
// first two letters of a one-word name
export function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

// "12 September 2026"
export function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
