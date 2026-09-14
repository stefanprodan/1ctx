// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  checkSchedule,
  nextFire,
  nextFires,
} from "../../../src/server/automations/index.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import fixtures from "../../fixtures/automations/next-fires.json";

describe("automation schedules", () => {
  test.each(fixtures)("finds the next fire in $tz from $from", (fixture) => {
    expect(
      new Date(
        nextFire(fixture.schedule, fixture.tz, Date.parse(fixture.from)),
      ).toISOString(),
    ).toBe(fixture.next);
  });

  test("answers strictly after an exact boundary", () => {
    const from = Date.parse("2026-09-14T06:00:00.000Z");
    expect(nextFire("0 9 * * *", "Europe/Bucharest", from)).toBe(
      Date.parse("2026-09-15T06:00:00.000Z"),
    );
  });

  test.each(["*/5 * * * *", "0 * * * *", "@hourly"])(
    "accepts the minimum gap in %s",
    (schedule) => {
      expect(() => checkSchedule(schedule, "UTC", 0)).not.toThrow();
    },
  );

  test.each(["* * * * *", "0,3 * * * *", "0-10 * * * *"])(
    "refuses a short minute gap in %s",
    (schedule) => {
      expect(() => checkSchedule(schedule, "UTC", 0)).toThrow(BadRequest);
    },
  );

  test("accepts a zone link and refuses an unknown zone", () => {
    expect(() => checkSchedule("0 * * * *", "UTC", 0)).not.toThrow();
    expect(() => checkSchedule("0 * * * *", "Not/AZone", 0)).toThrow(
      "invalid time zone",
    );
  });

  test("refuses a schedule that never fires", () => {
    expect(() => checkSchedule("0 0 30 2 *", "UTC", 0)).toThrow(
      "schedule never fires",
    );
  });

  test("finds consecutive fires", () => {
    const from = Date.parse("2026-09-14T06:00:00.000Z");
    expect(nextFires("0 9 * * *", "Europe/Bucharest", from, 3)).toEqual([
      Date.parse("2026-09-15T06:00:00.000Z"),
      Date.parse("2026-09-16T06:00:00.000Z"),
      Date.parse("2026-09-17T06:00:00.000Z"),
    ]);
  });

  test("crosses daylight saving time in Europe/Bucharest", () => {
    const fires = nextFires(
      "30 3 * * *",
      "Europe/Bucharest",
      Date.parse("2026-03-27T00:00:00.000Z"),
      5,
    );
    expect(fires.map((fire) => new Date(fire).toISOString())).toEqual([
      "2026-03-27T01:30:00.000Z",
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
  });
});
