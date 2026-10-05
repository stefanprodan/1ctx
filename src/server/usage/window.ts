// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// calendar windows in a zone; a day is a calendar day, never 24 h

import type { Windowed } from "../../shared/api/admin.ts";
import { MAX_WEEKS } from "../../shared/api/usage.ts";
import { isTimeZone } from "../../shared/words.ts";
import { DAY_MS } from "../lib/clock.ts";

export type UsageWindow = {
  days: string[];
  starts: number[];
  since: number;
  until: number;
};

type CalendarDay = { year: number; month: number; day: number };
type LocalParts = CalendarDay & {
  hour: number;
  minute: number;
  second: number;
};

const part = (parts: Intl.DateTimeFormatPart[], type: string): number =>
  Number(parts.find((value) => value.type === type)!.value);

const localParts = (
  formatter: Intl.DateTimeFormat,
  instant: number,
): LocalParts => {
  const parts = formatter.formatToParts(instant);
  return {
    year: part(parts, "year"),
    month: part(parts, "month"),
    day: part(parts, "day"),
    hour: part(parts, "hour"),
    minute: part(parts, "minute"),
    second: part(parts, "second"),
  };
};

const utcDate = (day: CalendarDay): Date => {
  const date = new Date(0);
  date.setUTCFullYear(day.year, day.month - 1, day.day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const utcInstant = (parts: LocalParts | CalendarDay): number => {
  const date = utcDate(parts);
  if ("hour" in parts) {
    date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  }
  return date.getTime();
};

const addDays = (day: CalendarDay, count: number): CalendarDay => {
  const date = utcDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const sameDay = (parts: CalendarDay, day: CalendarDay): boolean =>
  parts.year === day.year && parts.month === day.month && parts.day === day.day;

// The first instant of the day in the zone. Midnight is the wall time
// read as UTC, moved by the zone's offset; the offset a day either side
// covers a change near midnight. Where 00:00 happens twice the earlier
// wins; where a DST change skips it (Santiago, Havana) only the offset
// from before the jump lands inside the day, at the jump itself.
const midnight = (day: CalendarDay, formatter: Intl.DateTimeFormat): number => {
  const wall = utcInstant(day);
  const offsetAt = (instant: number) =>
    utcInstant(localParts(formatter, instant)) - instant;
  const inside = [offsetAt(wall - DAY_MS), offsetAt(wall + DAY_MS)]
    .map((offset) => wall - offset)
    .filter((instant) => sameDay(localParts(formatter, instant), day));
  // a day the zone skipped whole has no instant; it starts where it would
  return inside.length > 0 ? Math.min(...inside) : wall - offsetAt(wall);
};

const dayString = ({ year, month, day }: CalendarDay): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return dayString(addDays({ year, month, day: date }, 1));
}

// a rolling 30 days of 24 hours, not calendar days: the object pages'
// totals, [now - LAST_DAYS_MS, now)
export const LAST_DAYS_MS = 30 * DAY_MS;

export function lastDays<T extends object>(
  now: number,
  read: (since: number, until: number) => T,
): Windowed<T> {
  const since = now - LAST_DAYS_MS;
  return { since, until: now, ...read(since, now) };
}

// a zone the runtime does not know counts in UTC
export const zoneOrUtc = (timeZone: string): string =>
  isTimeZone(timeZone) ? timeZone : "UTC";

const zoneFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

const todayIn = (formatter: Intl.DateTimeFormat, now: number): CalendarDay => {
  const { year, month, day } = localParts(formatter, now);
  return { year, month, day };
};

// the days ending with today in the zone; how many can hang on today's
// weekday, so the year starts on a Monday
function calendarWindow(
  now: number,
  timeZone: string,
  span: (weekday: number) => number,
): UsageWindow {
  const formatter = zoneFormatter(timeZone);
  const today = todayIn(formatter, now);
  const weekday = utcDate(today).getUTCDay() || 7;
  const count = span(weekday);
  const first = addDays(today, 1 - count);
  const days: string[] = [];
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    const day = addDays(first, i);
    days.push(dayString(day));
    starts.push(midnight(day, formatter));
  }
  const until = midnight(addDays(today, 1), formatter);
  return { days, starts, since: starts[0]!, until };
}

export function usageWindow(
  now: number,
  timeZone: string,
  weeks = MAX_WEEKS,
): UsageWindow {
  return calendarWindow(now, timeZone, (weekday) => (weeks - 1) * 7 + weekday);
}

// the last `count` calendar days, today included, for another area's
// daily series in the caller's zone
export function daysWindow(
  now: number,
  timeZone: string,
  count: number,
): UsageWindow {
  return calendarWindow(now, timeZone, () => count);
}

// a month after this one has none
export function monthWindow(
  now: number,
  timeZone: string,
  month: string,
): UsageWindow {
  const formatter = zoneFormatter(timeZone);
  const today = todayIn(formatter, now);
  const [year, number] = month.split("-").map(Number) as [number, number];
  const first = { year, month: number, day: 1 };
  const next =
    number === 12
      ? { year: year + 1, month: 1, day: 1 }
      : { year, month: number + 1, day: 1 };
  const tomorrow = addDays(today, 1);
  const end = utcDate(next) < utcDate(tomorrow) ? next : tomorrow;
  const days: string[] = [];
  const starts: number[] = [];
  for (let day = first; utcDate(day) < utcDate(end); day = addDays(day, 1)) {
    days.push(dayString(day));
    starts.push(midnight(day, formatter));
  }
  const since = midnight(first, formatter);
  const until = Math.max(since, midnight(end, formatter));
  return { days, starts, since, until };
}

// how many of the instants fall on each day of a window, from the
// instant each day starts; one outside it is not counted
export function countByDay(
  starts: readonly number[],
  until: number,
  instants: readonly number[],
): number[] {
  const counts = starts.map(() => 0);
  for (const at of instants) {
    if (starts.length === 0 || at < starts[0]! || at >= until) continue;
    // the last day starting at or before the instant
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= at) low = mid;
      else high = mid - 1;
    }
    counts[low]!++;
  }
  return counts;
}
