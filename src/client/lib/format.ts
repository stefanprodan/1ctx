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

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "19 Sep", the same in every browser (Chrome's en-GB says "Sept")
export function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "19 Sep 2027"
export function dayMonthYear(ms: number): string {
  return `${dayMonth(ms)} ${new Date(ms).getFullYear()}`;
}

// "Sat 19 Sep"
export function weekdayDayMonth(ms: number): string {
  return `${WEEKDAYS[new Date(ms).getDay()]} ${dayMonth(ms)}`;
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

// a count the eye can take in: "637", "12.4K", "2.1M"
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toPrecision(3))}K`;
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

// a count the server made in OpenAI's encoding: "1 token", "2.72K tokens"
export function tokensText(n: number): string {
  return `${count(n)} token${n === 1 ? "" : "s"}`;
}

// the words of a thrown value, for a failure line
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// the server speaks in lowercase fragments; the page shows sentences
export function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  const upper = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

// a failure's words as drawn where no form maps them to a field; the
// raw words stay with reason() for the field mapping
export function says(err: unknown): string {
  return sentence(reason(err));
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

// what a cut block's Show all says: the lines the whole block holds
export function showAll(lines: number): string {
  return `Show all ${lines} ${lines === 1 ? "line" : "lines"}`;
}

// "1 file", "6.6K tokens"
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

// "48,210"
export const commas = (n: number): string => n.toLocaleString("en-GB");

// a dashboard's count, never rounded: "48,210 rows"
export function pluralCommas(n: number, one: string, many: string): string {
  return `${commas(n)} ${n === 1 ? one : many}`;
}

// tokens rounded to thousands: "850", "12K", "1.2M"
export function k(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

// a size as its number and its unit, three figures at most: "212", "MB"
export function sizeParts(bytes: number): { figure: string; unit: string } {
  const n = Math.max(0, bytes);
  const three = (v: number) => String(Number(v.toPrecision(3)));
  if (n < KB) return { figure: String(Math.round(n)), unit: "B" };
  if (n < MB) return { figure: three(n / KB), unit: "KB" };
  if (n < GB) return { figure: three(n / MB), unit: "MB" };
  return { figure: three(n / GB), unit: "GB" };
}

// "212 MB"
export function size(bytes: number): string {
  const { figure, unit } = sizeParts(bytes);
  return `${figure} ${unit}`;
}

// "12%", "<1%" for a sliver that is there, "0%" for none
export function share(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = part / whole;
  if (p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

// a size as a field says it: "256 KB", "4 MB"
// three significant digits, but never a rounded thousand: 1,023.5 MB
// to three digits is "1020 MB", so the next unit takes over at 1,000
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  for (const unit of ["KB", "MB", "GB"]) {
    value /= 1024;
    if (value < 1000 || unit === "GB") {
      const shown =
        value < 100 ? Number(value.toPrecision(3)) : Math.round(value);
      return `${shown} ${unit}`;
    }
  }
  return `${bytes} B`;
}

// an uploaded item's note: an archive's files, else its size
export function uploadNote(item: {
  archive: boolean;
  files: number;
  bytes: number;
}): string {
  return item.archive ? plural(item.files, "file") : sizeWords(item.bytes);
}

// a row's right side: "since 12 September 2026"
export function sinceLine(row: { createdAt: number }): string {
  return `since ${longDate(row.createdAt)}`;
}

// a share, 0 to 1, as a fill's width, clamped
export function shareWidth(share: number): string {
  return `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`;
}
