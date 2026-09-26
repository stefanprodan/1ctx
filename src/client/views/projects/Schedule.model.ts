// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schedule builder without a DOM: an expression read into the
// simplest shape that holds it (every few minutes, hourly, daily,
// weekly, monthly) or left as cron, a shape written back to its
// expression, and a fire as a line reads it. The
// server parses every expression; the builder only writes the ones
// people pick most, so a shape it does not know stays the user's text.

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

// Monday first, as a week reads; the value is cron's, Sunday 0
export const WEEK = [
  { value: 1, short: "M", name: "Monday" },
  { value: 2, short: "T", name: "Tuesday" },
  { value: 3, short: "W", name: "Wednesday" },
  { value: 4, short: "T", name: "Thursday" },
  { value: 5, short: "F", name: "Friday" },
  { value: 6, short: "S", name: "Saturday" },
  { value: 0, short: "S", name: "Sunday" },
] as const;

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

const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const pad = (n: number) => String(n).padStart(2, "0");

export const whole = (
  field: string,
  min: number,
  max: number,
): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
};

const dayOf = (field: string): number | null => {
  const named = DAY_NAMES.indexOf(field.toUpperCase());
  if (named !== -1) return named;
  const n = whole(field, 0, 7);
  return n === null ? null : n % 7;
};

// a day-of-week field as its set of days, sorted Sunday first: lists,
// ranges and names; null for steps or anything else
export function daysOf(field: string): number[] | null {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const d = dayOf(part);
      if (d === null) return null;
      out.add(d);
    } else if (range.length === 2) {
      // 7 is Sunday at the end of a range, as in 5-7
      const from = whole(range[0], 0, 7) ?? dayOf(range[0]);
      const rawTo = whole(range[1], 0, 7);
      const to = rawTo ?? dayOf(range[1]);
      if (from === null || to === null || from > to) return null;
      for (let d = from; d <= to; d++) out.add(d % 7);
    } else {
      return null;
    }
  }
  return [...out].sort((a, b) => a - b);
}

// the fields of an expression, a nickname opened up; null unless five
export function fieldsOf(expression: string): string[] | null {
  const text = expression.trim();
  const fields = (NICKNAMES[text.toLowerCase()] ?? text).split(/\s+/);
  return fields.length === 5 ? fields : null;
}

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
// 09:00", "Wed Sep 16 09:00"; lowercase inside a sentence
export function fireLabel(
  fire: number,
  now: number,
  tz: string,
  inline = false,
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
