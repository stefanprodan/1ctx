// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { usageWindow, weekWindow } from "../../../src/server/usage/window.ts";

const HOUR = 3_600_000;

describe("usageWindow", () => {
  test.each([
    ["2026-09-14", 1],
    ["2026-09-15", 2],
    ["2026-09-16", 3],
    ["2026-09-17", 4],
    ["2026-09-18", 5],
    ["2026-09-19", 6],
    ["2026-09-20", 7],
  ])("ends on %s with 53 Monday-first columns", (today, weekday) => {
    const window = usageWindow(Date.parse(`${today}T12:00:00Z`), "UTC");
    expect(window.days).toHaveLength(364 + weekday);
    expect(window.days[0]).toBe("2025-09-15");
    expect(window.days.at(-1)).toBe(today);
    expect(new Date(`${window.days[0]}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(window.since).toBe(Date.parse("2025-09-15T00:00:00Z"));
    expect(window.until).toBe(Date.parse(`${today}T00:00:00Z`) + 24 * HOUR);
    expect(window.starts).toHaveLength(window.days.length);
  });

  test("resolves Bucharest's spring day as 23 hours", () => {
    const window = usageWindow(
      Date.parse("2026-03-29T12:00:00Z"),
      "Europe/Bucharest",
    );
    const index = window.days.indexOf("2026-03-29");
    expect(window.since).toBe(Date.parse("2025-03-23T22:00:00Z"));
    expect(window.until).toBe(Date.parse("2026-03-29T21:00:00Z"));
    expect(window.until - window.starts[index]!).toBe(23 * HOUR);
  });

  test("resolves Bucharest's autumn day as 25 hours", () => {
    const window = usageWindow(
      Date.parse("2026-10-25T12:00:00Z"),
      "Europe/Bucharest",
    );
    const index = window.days.indexOf("2026-10-25");
    expect(window.since).toBe(Date.parse("2025-10-19T21:00:00Z"));
    expect(window.until).toBe(Date.parse("2026-10-25T22:00:00Z"));
    expect(window.until - window.starts[index]!).toBe(25 * HOUR);
  });

  test("starts a day whose midnight DST skips at the jump", () => {
    const santiago = usageWindow(
      Date.parse("2026-09-14T12:00:00Z"),
      "America/Santiago",
    );
    const sunday = santiago.days.indexOf("2026-09-06");
    // 00:00 at -4 is 01:00 at -3, so the day starts at the jump and the
    // Saturday before keeps its full 24 hours
    expect(santiago.starts[sunday]).toBe(Date.parse("2026-09-06T04:00:00Z"));
    expect(santiago.starts[sunday]! - santiago.starts[sunday - 1]!).toBe(
      24 * HOUR,
    );
    expect(santiago.starts[sunday + 1]! - santiago.starts[sunday]!).toBe(
      23 * HOUR,
    );

    const havana = usageWindow(
      Date.parse("2026-04-10T03:00:00Z"),
      "America/Havana",
    );
    const day = havana.days.indexOf("2026-03-08");
    expect(havana.starts[day]).toBe(Date.parse("2026-03-08T05:00:00Z"));
  });

  test("every day starts at its first local instant, in order", () => {
    const zones = [
      "America/Santiago",
      "America/Havana",
      "America/Asuncion",
      "Asia/Beirut",
      "Africa/Cairo",
      "Australia/Lord_Howe",
      "Europe/Bucharest",
    ];
    for (const zone of zones) {
      const w = usageWindow(Date.parse("2026-09-14T12:00:00Z"), zone);
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      w.starts.forEach((start, i) => {
        expect(date.format(start)).toBe(w.days[i]!);
        expect(date.format(start - 1)).not.toBe(w.days[i]!);
        expect((w.starts[i + 1] ?? w.until) > start).toBe(true);
      });
    }
  });

  test("resolves St Johns half-hour boundaries", () => {
    const window = usageWindow(
      Date.parse("2026-07-15T12:00:00Z"),
      "America/St_Johns",
    );
    const today = window.days.indexOf("2026-07-15");
    expect(window.since).toBe(Date.parse("2025-07-14T02:30:00Z"));
    expect(window.starts[today]).toBe(Date.parse("2026-07-15T02:30:00Z"));
    expect(window.until).toBe(Date.parse("2026-07-16T02:30:00Z"));
  });

  test.each([
    [
      "Pacific/Kiritimati",
      "2026-09-14",
      "2025-09-14T10:00:00Z",
      "2026-09-14T10:00:00Z",
    ],
    [
      "Pacific/Pago_Pago",
      "2026-09-13",
      "2025-09-08T11:00:00Z",
      "2026-09-14T11:00:00Z",
    ],
  ])("resolves the %s timezone extreme", (tz, today, since, until) => {
    const window = usageWindow(Date.parse("2026-09-14T00:00:00Z"), tz);
    expect(window.days.at(-1)).toBe(today);
    expect(window.since).toBe(Date.parse(since));
    expect(window.until).toBe(Date.parse(until));
  });

  test("crosses a year end without breaking calendar days", () => {
    const window = usageWindow(Date.parse("2026-01-02T12:00:00Z"), "UTC");
    expect(window.days[0]).toBe("2024-12-30");
    expect(window.days.at(-1)).toBe("2026-01-02");
    expect(window.days).toContain("2025-12-31");
    expect(window.days).toContain("2026-01-01");
    expect(window.until).toBe(Date.parse("2026-01-03T00:00:00Z"));
  });

  test("the week is the last seven local days, today included", () => {
    const week = weekWindow(
      Date.parse("2026-03-29T12:00:00Z"),
      "Europe/Bucharest",
    );
    expect(week.days).toEqual([
      "2026-03-23",
      "2026-03-24",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
    expect(week.since).toBe(Date.parse("2026-03-22T22:00:00Z"));
    // the spring change makes the week an hour short
    expect(week.until - week.since).toBe(7 * 24 * HOUR - HOUR);
    const year = usageWindow(
      Date.parse("2026-03-29T12:00:00Z"),
      "Europe/Bucharest",
    );
    expect(year.starts.slice(-7)).toEqual(week.starts);
    expect(year.until).toBe(week.until);
  });
});
