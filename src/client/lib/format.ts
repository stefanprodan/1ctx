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

const DAY = 86_400_000;

// a span in the compact units a feed uses, one letter and no space:
// "40s", "23m", "6h", "2d", "3w"
function span(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d`;
  return `${Math.floor(ms / (7 * DAY))}w`;
}

// how long ago, at the coarseness a list wants: "40s ago" up to
// "3w ago", then the day and month, with the year once it is a year
// back
export function ago(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < 28 * DAY) return `${span(delta)} ago`;
  const date = new Date(ms);
  const year = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

// how long until, in the same units: "in 40s", "in 4h", "in 2d"
export function until(ms: number, now: number): string {
  return `in ${span(Math.max(0, ms - now))}`;
}

// a count the eye can take in: "637", "12.4k", "2.1M"
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toPrecision(3))}k`;
  return `${Number((n / 1_000_000).toPrecision(3))}M`;
}

// how long something has run, in the same units: "40s", "2m", "1h"
export function elapsed(ms: number): string {
  return span(Math.max(0, ms));
}

// a description's first sentence, for a row's head
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

// a count the server made in OpenAI's encoding: "1 token", "2.72k tokens"
export function tokensText(n: number): string {
  return `${count(n)} token${n === 1 ? "" : "s"}`;
}

// the words of a thrown value, for a failure line
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// a failure as a page shows it: the words, and the HTTP status when the
// server answered with one (null when it did not answer or nothing was
// asked of it)
export type Failure = { words: string; status: number | null };

export function failure(err: unknown): Failure {
  const status =
    err instanceof Error && "status" in err && typeof err.status === "number"
      ? err.status
      : null;
  return { words: reason(err), status: status === 0 ? null : status };
}
