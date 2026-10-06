// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  isOverviewRange,
  MONTH_PATTERN,
  type OverviewRange,
} from "../../shared/api/admin.ts";
import { queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { zoneParam } from "../usage/index.ts";

// the canonical name, since Intl takes any case and the cache keys on it
export function canonicalZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
    .timeZone;
}

export function parseOverviewQuery(url: URL): {
  timeZone: string;
  range: OverviewRange;
} {
  const get = queryParams(url, ["tz", "range"]);
  const range = get("range") ?? "30d";
  if (!isOverviewRange(range)) throw new BadRequest("unknown range");
  return { timeZone: canonicalZone(zoneParam(get)), range };
}

export function parseUsageQuery(url: URL): {
  timeZone: string;
  month: string;
} {
  const get = queryParams(url, ["tz", "month"]);
  const month = get("month");
  if (month === null) throw new BadRequest("month is required");
  if (!MONTH_PATTERN.test(month)) throw new BadRequest("month is YYYY-MM");
  return { timeZone: canonicalZone(zoneParam(get)), month };
}
