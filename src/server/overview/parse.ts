// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage route takes the caller's zone and nothing else, the
// overview route the zone and its range; anything unexpected is a 400.

import { OVERVIEW_RANGES, type OverviewRange } from "../../shared/api/admin.ts";
import { isTimeZone } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";

function only(url: URL, names: readonly string[]): void {
  for (const name of url.searchParams.keys()) {
    if (!names.includes(name)) {
      throw new BadRequest(`unknown parameter ${name}`);
    }
  }
}

function one(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) throw new BadRequest(`${name} is required`);
  if (values.length !== 1) throw new BadRequest(`${name} must appear once`);
  return values[0]!;
}

function zone(url: URL): string {
  const timeZone = one(url, "tz");
  if (!isTimeZone(timeZone)) throw new BadRequest("unknown tz");
  return timeZone;
}

export function parseStorageQuery(url: URL): string {
  only(url, ["tz"]);
  return zone(url);
}

export function parseOverviewQuery(url: URL): {
  timeZone: string;
  days: OverviewRange;
} {
  only(url, ["tz", "days"]);
  const timeZone = zone(url);
  const raw = one(url, "days");
  const days = OVERVIEW_RANGES.find((range) => String(range) === raw);
  if (days === undefined) {
    throw new BadRequest(`days must be one of ${OVERVIEW_RANGES.join(", ")}`);
  }
  return { timeZone, days };
}
