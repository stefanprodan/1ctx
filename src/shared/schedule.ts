// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A schedule in words, read by the task's page and the automation
// tool alike, and the cron fields they read it from. A shape the words
// do not know is null, and the caller shows the expression.

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

const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

// "Monday", "Monday and Friday", "Monday, Wednesday and Friday", in
// week order
const dayList = (days: number[]): string => {
  const names = WEEK.filter((d) => days.includes(d.value)).map((d) => d.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

// "every weekday at 09:00", "every 15 minutes"; null for a shape the
// words do not know
export function scheduleWords(schedule: string): string | null {
  const fields = fieldsOf(schedule);
  if (fields === null) return null;
  const [min, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return null;
  const step = /^\*\/(\d{1,2})$/.exec(min);
  if (step && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(step[1]);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  const m = whole(min, 0, 59);
  if (m === null) return null;
  if (hour === "*" && dom === "*" && dow === "*") {
    return m === 0 ? "every hour" : `every hour at :${pad(m)}`;
  }
  const h = whole(hour, 0, 23);
  if (h === null) return null;
  const at = `at ${pad(h)}:${pad(m)}`;
  if (dom === "*") {
    const days = daysOf(dow);
    if (days === null) return null;
    const key = days.join(",");
    if (days.length === 7) return `every day ${at}`;
    if (key === "1,2,3,4,5") return `every weekday ${at}`;
    if (key === "0,6") return `every weekend day ${at}`;
    return `every ${dayList(days)} ${at}`;
  }
  if (dow === "*") {
    const d = whole(dom, 0, 31);
    return d === null || d === 0
      ? null
      : `on the ${ordinal(d)} of each month ${at}`;
  }
  return null;
}
