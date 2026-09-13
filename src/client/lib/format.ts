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

// the time of day, "08:41"
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// the day and the time of day, "Sep 13, 16:23"
export function stamp(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${day}, ${clock(ms)}`;
}

// how long ago, at the coarseness a list wants: "40 s ago", "5 min
// ago", "2 h ago", "yesterday", the weekday within the week, else the
// day and month
export function ago(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)} s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days === 1) return "yesterday";
  const date = new Date(ms);
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "short" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// how long something has run, at the coarseness a list wants: "40 s",
// "2 min", "1 h"
export function elapsed(ms: number): string {
  const delta = Math.max(0, ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)} s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min`;
  return `${Math.floor(delta / 3_600_000)} h`;
}
