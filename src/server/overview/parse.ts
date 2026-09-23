// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage route takes the caller's zone and nothing else; anything
// unexpected is a 400.

import { isTimeZone } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";

export function parseStorageQuery(url: URL): string {
  for (const name of url.searchParams.keys()) {
    if (name !== "tz") throw new BadRequest(`unknown parameter ${name}`);
  }
  const values = url.searchParams.getAll("tz");
  if (values.length === 0) throw new BadRequest("tz is required");
  if (values.length !== 1) throw new BadRequest("tz must appear once");
  const timeZone = values[0]!;
  if (!isTimeZone(timeZone)) throw new BadRequest("unknown tz");
  return timeZone;
}
