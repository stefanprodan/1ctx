// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { MAX_SCHEDULE, MAX_TZ } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";

export const MIN_GAP_MINUTES = 5;

const NICKNAMES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function expandPart(part: string): number[] {
  const [span, stepRaw] = part.split("/");
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  let start: number;
  let end: number;
  if (span === "*") {
    start = 0;
    end = 59;
  } else if (span.includes("-")) {
    const [a, b] = span.split("-").map(Number);
    start = a!;
    end = b!;
  } else {
    start = Number(span);
    end = start;
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    !Number.isInteger(step) ||
    start < 0 ||
    end > 59 ||
    start > end ||
    step < 1
  ) {
    throw new BadRequest("invalid schedule");
  }
  const out: number[] = [];
  for (let minute = start; minute <= end; minute += step) out.push(minute);
  return out;
}

function checkGap(schedule: string): void {
  const expanded = NICKNAMES[schedule.toLowerCase()] ?? schedule;
  const parts = expanded.trim().split(/\s+/);
  if (parts.length !== 5) throw new BadRequest("invalid schedule");
  const minutes = [...new Set(parts[0]!.split(",").flatMap(expandPart))].sort(
    (a, b) => a - b,
  );
  if (minutes.length === 0) throw new BadRequest("invalid schedule");
  for (let i = 0; i < minutes.length; i++) {
    const current = minutes[i]!;
    const next = minutes[(i + 1) % minutes.length]!;
    const gap = i + 1 === minutes.length ? next + 60 - current : next - current;
    if (gap < MIN_GAP_MINUTES) {
      throw new BadRequest("schedule fires too often");
    }
  }
}

function checkZone(tz: string): void {
  if (tz === "" || tz.length > MAX_TZ)
    throw new BadRequest("invalid time zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format(0);
  } catch {
    throw new BadRequest("invalid time zone");
  }
}

export function nextFire(schedule: string, tz: string, from: number): number {
  let date: Date | null;
  try {
    date = Bun.cron.parse(schedule, from, { tz });
  } catch {
    throw new BadRequest("invalid schedule");
  }
  if (date === null) throw new BadRequest("schedule never fires");
  if (date.getTime() > from) return date.getTime();
  try {
    date = Bun.cron.parse(schedule, from + 60_000, { tz });
  } catch {
    throw new BadRequest("invalid schedule");
  }
  if (date === null || date.getTime() <= from) {
    throw new BadRequest("schedule never fires");
  }
  return date.getTime();
}

export function nextFires(
  schedule: string,
  tz: string,
  from: number,
  count: number,
): number[] {
  if (count < 1) return [];
  const fires = [checkSchedule(schedule, tz, from)];
  while (fires.length < count) {
    fires.push(nextFire(schedule, tz, fires.at(-1)!));
  }
  return fires;
}
export function checkSchedule(
  schedule: string,
  tz: string,
  from = Date.now(),
): number {
  if (schedule === "" || schedule.length > MAX_SCHEDULE) {
    throw new BadRequest("invalid schedule");
  }
  checkZone(tz);
  checkGap(schedule);
  return nextFire(schedule, tz, from);
}
