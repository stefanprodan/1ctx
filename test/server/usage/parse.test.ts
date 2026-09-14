// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  parseDaysUsageQuery,
  parseWeekUsageQuery,
} from "../../../src/server/usage/parse.ts";

const url = (path: string, query: string) =>
  new URL(`http://1ctx.test/api/usage/${path}${query}`);
const days = (query: string) => parseDaysUsageQuery(url("days", query));
const week = (query: string) => parseWeekUsageQuery(url("week", query));

describe("the usage parsers", () => {
  test.each(["UTC", "Europe/Bucharest", "America/St_Johns"])(
    "accept %s",
    (timeZone) => {
      const tz = `?tz=${encodeURIComponent(timeZone)}`;
      expect(week(tz)).toBe(timeZone);
      expect(days(tz)).toEqual({ timeZone, weeks: 53 });
    },
  );

  test.each([
    ["missing", ""],
    ["empty", "?tz="],
    ["repeated", "?tz=UTC&tz=Europe%2FBucharest"],
    ["over 64 bytes", `?tz=${"a".repeat(65)}`],
    ["unknown", "?tz=Mars%2FOlympus"],
    ["extra", "?tz=UTC&days=1"],
    ["only extra", "?days=1"],
  ])("refuse a %s zone query", (_name, query) => {
    expect(() => week(query)).toThrow(BadRequest);
    expect(() => days(query)).toThrow(BadRequest);
  });

  test("the days route takes weeks from 1 to 53", () => {
    expect(days("?tz=UTC&weeks=1")).toEqual({ timeZone: "UTC", weeks: 1 });
    expect(days("?tz=UTC&weeks=16")).toEqual({ timeZone: "UTC", weeks: 16 });
    expect(days("?tz=UTC&weeks=53")).toEqual({ timeZone: "UTC", weeks: 53 });
    for (const weeks of ["0", "54", "05", "1e1", " 5", "-1", "2.5", ""]) {
      expect(() => days(`?tz=UTC&weeks=${encodeURIComponent(weeks)}`)).toThrow(
        BadRequest,
      );
    }
    expect(() => days("?tz=UTC&weeks=5&weeks=6")).toThrow(BadRequest);
  });

  test("the week route takes no weeks", () => {
    expect(() => week("?tz=UTC&weeks=5")).toThrow(BadRequest);
  });
});
