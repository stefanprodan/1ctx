// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The time zone picker's options, apart from the DOM: every zone the
// runtime lists, with its offset now and its country, matched by its
// cities too.

import { placeOf } from "../lib/places.ts";
import type { Option } from "./Select.model.ts";

// the offset a zone is at now, "GMT+3", "GMT-4", "GMT"; empty when the
// runtime cannot say
export function offsetOf(tz: string, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // runtimes differ on zero: Bun says GMT+0 where Chrome says GMT
    return name === "GMT+0" ? "GMT" : name;
  } catch {
    return "";
  }
}

// the zone picker's options: every zone the runtime lists with its
// offset now and its country, matched by its cities too, and the row's
// own zone when the list leaves it out, since the server takes links
// such as UTC
export function zoneOptions(
  zones: string[],
  current: string,
  now: number,
): Option[] {
  const names =
    zones.includes(current) || current === "" ? zones : [current, ...zones];
  return names.map((tz) => {
    const place = placeOf(tz);
    const country = place?.countries.join(", ") ?? "";
    return {
      value: tz,
      label: tz,
      detail: [offsetOf(tz, now), country].filter(Boolean).join(" · "),
      keywords: place?.cities ?? "",
    };
  });
}
