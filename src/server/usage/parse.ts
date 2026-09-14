// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Both usage routes take the caller's zone; the days route may also
// take how many weeks, up to the year. Anything else is a 400, as every
// parser answers the unexpected.

import { BadRequest } from "../lib/errors.ts";
import { MAX_WEEKS } from "./window.ts";

function only(url: URL, allowed: string[]): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) {
      throw new BadRequest(`unknown parameter ${name}`);
    }
  }
}

function zoneOf(url: URL): string {
  const values = url.searchParams.getAll("tz");
  if (values.length === 0) throw new BadRequest("tz is required");
  if (values.length !== 1) throw new BadRequest("tz must appear once");
  const timeZone = values[0]!;
  if (timeZone === "") throw new BadRequest("tz is required");
  if (new TextEncoder().encode(timeZone).byteLength > 64) {
    throw new BadRequest("tz is too long");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new BadRequest("unknown tz");
  }
  return timeZone;
}

export function parseWeekUsageQuery(url: URL): string {
  only(url, ["tz"]);
  return zoneOf(url);
}

export function parseDaysUsageQuery(url: URL): {
  timeZone: string;
  weeks: number;
} {
  only(url, ["tz", "weeks"]);
  const timeZone = zoneOf(url);
  const values = url.searchParams.getAll("weeks");
  if (values.length === 0) return { timeZone, weeks: MAX_WEEKS };
  if (values.length !== 1) throw new BadRequest("weeks must appear once");
  const raw = values[0]!;
  // digits only, so "1e1", " 5" and "05" are not numbers here
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > MAX_WEEKS) {
    throw new BadRequest(`weeks must be 1 to ${MAX_WEEKS}`);
  }
  return { timeZone, weeks: Number(raw) };
}
