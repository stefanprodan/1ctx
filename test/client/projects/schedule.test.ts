// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  builderOf,
  daysOf,
  expressionOf,
  fireLabel,
  switchEvery,
} from "../../../src/client/views/projects/Schedule.model.ts";

describe("reading an expression into a shape", () => {
  test("the shapes the builder writes", () => {
    expect(builderOf("*/15 * * * *")).toMatchObject({
      every: "minutes",
      step: 15,
    });
    expect(builderOf("20 * * * *")).toMatchObject({
      every: "hourly",
      minute: 20,
    });
    expect(builderOf("30 7 * * *")).toMatchObject({
      every: "daily",
      time: "07:30",
    });
    expect(builderOf("0 9 * * MON-FRI")).toMatchObject({
      every: "weekly",
      time: "09:00",
      days: [1, 2, 3, 4, 5],
    });
    expect(builderOf("0 18 1 * *")).toMatchObject({
      every: "monthly",
      time: "18:00",
      dayOfMonth: 1,
    });
    expect(builderOf("@daily")).toMatchObject({
      every: "daily",
      time: "00:00",
    });
  });

  test("anything else stays cron, as typed", () => {
    for (const text of [
      "*/7 * * * *",
      "0 9,17 * * *",
      "0 9 1 * MON",
      "0 9 * 1 *",
      "0 */2 * * *",
      "not cron",
      "",
    ]) {
      expect(builderOf(text)).toMatchObject({ every: "cron", cron: text });
    }
  });

  test("a day field as its days, Sunday 0 or 7", () => {
    expect(daysOf("*")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(daysOf("SAT,SUN")).toEqual([0, 6]);
    expect(daysOf("5-7")).toEqual([0, 5, 6]);
    expect(daysOf("mon-wed,fri")).toEqual([1, 2, 3, 5]);
    expect(daysOf("*/2")).toBeNull();
    expect(daysOf("5-1")).toBeNull();
  });
});

describe("writing a shape back", () => {
  test("each shape writes its expression, and reads back the same", () => {
    for (const text of [
      "*/5 * * * *",
      "0 * * * *",
      "45 6 * * *",
      "0 9 * * 1-5",
      "0 9 * * 1,3,5",
      "0 9 * * 0,6",
      "15 18 28 * *",
    ]) {
      expect(expressionOf(builderOf(text))).toBe(text);
    }
  });

  test("days come out sorted, with runs of three as ranges", () => {
    const b = builderOf("0 9 * * 1-5");
    expect(expressionOf({ ...b, days: [5, 1, 4, 3, 2] })).toBe("0 9 * * 1-5");
    expect(expressionOf({ ...b, days: [1, 2] })).toBe("0 9 * * 1,2");
    expect(expressionOf({ ...b, days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      "0 9 * * *",
    );
  });

  test("a missing day or time writes nothing", () => {
    const b = builderOf("0 9 * * 1-5");
    expect(expressionOf({ ...b, days: [] })).toBe("");
    expect(expressionOf({ ...b, time: "" })).toBe("");
    expect(expressionOf({ ...b, time: "24:00" })).toBe("");
  });

  test("switching keeps the fields, and cron starts from the screen", () => {
    const weekly = builderOf("30 8 * * 1,3");
    const daily = switchEvery(weekly, "daily");
    expect(expressionOf(daily)).toBe("30 8 * * *");
    expect(expressionOf(switchEvery(daily, "weekly"))).toBe("30 8 * * 1,3");
    const cron = switchEvery(weekly, "cron");
    expect(cron.cron).toBe("30 8 * * 1,3");
    expect(switchEvery(cron, "cron")).toBe(cron);
  });
});

describe("a fire in words", () => {
  // Monday 14 September 2026, 20:10 in Bucharest
  const now = Date.UTC(2026, 8, 14, 17, 10);
  const at = (day: number, h: number, m = 0) =>
    Date.UTC(2026, 8, day, h - 3, m);

  test("a fire reads as today, tomorrow or its date", () => {
    const tz = "Europe/Bucharest";
    expect(fireLabel(at(14, 21, 15), now, tz)).toBe("Today 21:15");
    expect(fireLabel(at(15, 9), now, tz)).toBe("Tomorrow 09:00");
    expect(fireLabel(at(15, 9), now, tz, true)).toBe("tomorrow 09:00");
    expect(fireLabel(at(16, 9), now, tz)).toBe("Wed Sep 16 09:00");
    expect(fireLabel(at(16, 9), now, "Not/AZone")).toBe("");
  });

  test("tomorrow is the next calendar day across a daylight change", () => {
    // 23:30 on Saturday 28 March 2026 in Bucharest; the clocks spring
    // forward that night, so 09:00 is less than 24 hours on
    const late = Date.UTC(2026, 2, 28, 21, 30);
    const fire = Date.UTC(2026, 2, 29, 6, 0);
    expect(fireLabel(fire, late, "Europe/Bucharest")).toBe("Tomorrow 09:00");
    // and a day and a half away on the long autumn night is not
    const autumn = Date.UTC(2026, 9, 24, 20, 30);
    const after = Date.UTC(2026, 9, 26, 7, 0);
    expect(fireLabel(after, autumn, "Europe/Bucharest")).toBe(
      "Mon Oct 26 09:00",
    );
  });
});
