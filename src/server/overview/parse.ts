// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage and the overview routes take the caller's zone and
// nothing else, the load route nothing; anything unexpected is a 400.

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

// the storage and the overview routes take the zone and nothing else
export function parseZoneQuery(url: URL): string {
  only(url, ["tz"]);
  return zone(url);
}

// the load is the process's, in no zone
export function parseLoadQuery(url: URL): void {
  only(url, []);
}
