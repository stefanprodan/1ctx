// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// the query parsers of the zone-taking routes

import { MAX_WEEKS } from "../../shared/api/usage.ts";
import { isTimeZone, MAX_TZ } from "../../shared/words.ts";
import { queryParams } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

// ?tz=, as given: one IANA zone the runtime knows
export function zoneParam(get: (name: string) => string | null): string {
  const timeZone = get("tz");
  if (timeZone === null || timeZone === "") {
    throw new BadRequest("tz is required");
  }
  if (timeZone.length > MAX_TZ) throw new BadRequest("tz is too long");
  if (!isTimeZone(timeZone)) throw new BadRequest("unknown tz");
  return timeZone;
}

export function parseZoneQuery(url: URL): string {
  return zoneParam(queryParams(url, ["tz"]));
}

export function parseDaysUsageQuery(url: URL): {
  timeZone: string;
  weeks: number;
} {
  const get = queryParams(url, ["tz", "weeks"]);
  const timeZone = zoneParam(get);
  const raw = get("weeks");
  if (raw === null) return { timeZone, weeks: MAX_WEEKS };
  // digits only, so "1e1", " 5" and "05" are not numbers here
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > MAX_WEEKS) {
    throw new BadRequest(`weeks must be 1 to ${MAX_WEEKS}`);
  }
  return { timeZone, weeks: Number(raw) };
}
