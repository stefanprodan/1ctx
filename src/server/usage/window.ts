// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The activity window: up to 53 ISO weeks in the caller's zone, Monday first,
// today last, and the instant each day starts. A day is a calendar day,
// so one across a DST change is 23 or 25 hours; nothing here divides a
// timestamp, which would bucket by a fixed offset.

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

const DAY_MS = 86_400_000;
// a year of columns, so the widest card fills with small cells
export const MAX_WEEKS = 53;

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

// the days ending with today in the zone; how many can hang on today's
// weekday, so the year starts on a Monday
function calendarWindow(
  now: number,
  timeZone: string,
  span: (weekday: number) => number,
): UsageWindow {
  const formatter = new Intl.DateTimeFormat("en", {
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
  const local = localParts(formatter, now);
  const today = { year: local.year, month: local.month, day: local.day };
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

// the aside's week: the last seven calendar days, today included, so its
// numbers match the heatmap's last seven cells
export function weekWindow(now: number, timeZone: string): UsageWindow {
  return calendarWindow(now, timeZone, () => 7);
}
