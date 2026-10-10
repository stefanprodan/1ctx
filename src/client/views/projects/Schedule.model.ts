// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schedule builder without a DOM: an expression read into the
// simplest shape that holds it (every few minutes, hourly, daily,
// weekly, monthly) or left as cron, a shape written back to its
// expression, and a fire as a line reads it. The server parses every
// expression; the builder only writes the ones people pick most, so a
// shape it does not know stays the user's text. The words are
// shared/schedule.ts's.

import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import {
  daysOf,
  fieldsOf,
  pad,
  scheduleWords,
  whole,
} from "../../../shared/schedule.ts";

export const EVERY = [
  "minutes",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "cron",
] as const;
export type Every = (typeof EVERY)[number];

export const EVERY_LABELS: Record<Every, string> = {
  minutes: "Minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  cron: "Cron",
};

// the steps the minutes shape offers; the server's gap is the floor
export const STEPS = [5, 10, 15, 20, 30] as const;

export type Builder = {
  every: Every;
  step: number;
  // the minute past the hour, for hourly
  minute: number;
  // "HH:MM", for daily, weekly and monthly
  time: string;
  // cron's day numbers, for weekly
  days: number[];
  dayOfMonth: number;
  // the expression as typed, for cron
  cron: string;
};

const DEFAULTS: Omit<Builder, "every" | "cron"> = {
  step: 15,
  minute: 0,
  time: "09:00",
  days: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
};

// the simplest shape that writes the expression back as it means;
// anything else stays cron with the text as it is
export function builderOf(expression: string): Builder {
  const cron: Builder = { ...DEFAULTS, every: "cron", cron: expression };
  const fields = fieldsOf(expression);
  if (fields === null) return cron;
  const [min, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return cron;
  const step = /^\*\/(\d{1,2})$/.exec(min);
  if (step && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(step[1]);
    return (STEPS as readonly number[]).includes(n)
      ? { ...cron, every: "minutes", step: n }
      : cron;
  }
  const m = whole(min, 0, 59);
  if (m === null) return cron;
  if (hour === "*") {
    return dom === "*" && dow === "*"
      ? { ...cron, every: "hourly", minute: m }
      : cron;
  }
  const h = whole(hour, 0, 23);
  if (h === null) return cron;
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return { ...cron, every: "daily", time };
  if (dom === "*") {
    const days = daysOf(dow);
    return days === null ? cron : { ...cron, every: "weekly", time, days };
  }
  if (dow === "*") {
    const d = whole(dom, 1, 31);
    return d === null
      ? cron
      : { ...cron, every: "monthly", time, dayOfMonth: d };
  }
  return cron;
}

// cron's day field for a set of days: runs of three or more as ranges
function dayField(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(",");
}

const timeParts = (time: string): [number, number] | null => {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!hit) return null;
  const h = Number(hit[1]);
  const m = Number(hit[2]);
  return h <= 23 && m <= 59 ? [h, m] : null;
};

// the expression a shape writes; empty when a field it needs is not
// there yet (no day picked, no time), which the form reports
export function expressionOf(b: Builder): string {
  switch (b.every) {
    case "cron":
      return b.cron.trim();
    case "minutes":
      return `*/${b.step} * * * *`;
    case "hourly":
      return `${b.minute} * * * *`;
    default: {
      const t = timeParts(b.time);
      if (t === null) return "";
      const [h, m] = t;
      if (b.every === "daily") return `${m} ${h} * * *`;
      if (b.every === "monthly") return `${m} ${h} ${b.dayOfMonth} * *`;
      if (b.days.length === 0) return "";
      if (b.days.length === 7) return `${m} ${h} * * *`;
      return `${m} ${h} * * ${dayField(b.days)}`;
    }
  }
}

// another shape picked: the fields keep what the last shape had, and
// cron starts from the expression on screen, so nothing typed is lost
export function switchEvery(b: Builder, every: Every): Builder {
  if (every === b.every) return b;
  if (every === "cron") return { ...b, every, cron: expressionOf(b) };
  return { ...b, every };
}

// a fire as a list reads it, in the zone: "Today 21:15", "Tomorrow
// 09:00", "Wed Sep 16 09:00"; lowercase inside a sentence. With year,
// a later day names it, "Sun Oct 11 2026 09:00", since a task's one
// fire may be a year off
export function fireLabel(
  fire: number,
  now: number,
  tz: string,
  inline = false,
  year = false,
): string {
  try {
    const day = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).format(ms);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(fire);
    // the next calendar day in the zone, which a daylight change makes
    // 23 or 25 hours away
    let next = now;
    while (day(next) === day(now)) next += 3_600_000;
    if (day(fire) === day(now)) return `${inline ? "today" : "Today"} ${time}`;
    if (day(fire) === day(next)) {
      return `${inline ? "tomorrow" : "Tomorrow"} ${time}`;
    }
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" as const } : {}),
    })
      .formatToParts(fire)
      .filter((p) => p.type !== "literal")
      .map((p) => p.value)
      .join(" ");
    return `${date} ${time}`;
  } catch {
    return "";
  }
}

// the words with a capital, for a line of their own
export function scheduleTitle(schedule: string): string {
  const words = scheduleWords(schedule);
  return words === null
    ? schedule
    : `${words[0].toUpperCase()}${words.slice(1)}`;
}

// the list's schedule column: the words, or the expression, and
// "once" for a task that runs once
export function scheduleColumn(
  a: Pick<AutomationSummary, "schedule" | "once">,
): string {
  const words = scheduleWords(a.schedule) ?? a.schedule;
  return a.once ? `${words}, once` : words;
}
