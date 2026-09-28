// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  isOverviewRange,
  MONTH_PATTERN,
  type OverviewRange,
} from "../../shared/api/admin.ts";
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

// the canonical name, since Intl takes any case and the cache keys on it
function zone(url: URL): string {
  const timeZone = one(url, "tz");
  if (!isTimeZone(timeZone)) throw new BadRequest("unknown tz");
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
    .timeZone;
}

export function parseZoneQuery(url: URL): string {
  only(url, ["tz"]);
  return zone(url);
}

export function parseOverviewQuery(url: URL): {
  timeZone: string;
  range: OverviewRange;
} {
  only(url, ["tz", "range"]);
  const values = url.searchParams.getAll("range");
  if (values.length > 1) throw new BadRequest("range must appear once");
  const range = values[0] ?? "30d";
  if (!isOverviewRange(range)) throw new BadRequest("unknown range");
  return { timeZone: zone(url), range };
}

export function parseUsageQuery(url: URL): {
  timeZone: string;
  month: string;
} {
  only(url, ["tz", "month"]);
  const month = one(url, "month");
  if (!MONTH_PATTERN.test(month)) throw new BadRequest("month is YYYY-MM");
  return { timeZone: zone(url), month };
}

export function parseNoQuery(url: URL): void {
  only(url, []);
}
