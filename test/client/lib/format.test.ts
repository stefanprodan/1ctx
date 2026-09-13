// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ago, clock, elapsed, stamp } from "../../../src/client/lib/format.ts";

describe("time formatting", () => {
  const now = new Date(2026, 8, 13, 12).getTime();

  test.each([
    ["59 seconds", 59_000, "59 s ago"],
    ["1 minute", 60_000, "1 min ago"],
    ["59 minutes", 59 * 60_000, "59 min ago"],
    ["1 hour", 60 * 60_000, "1 h ago"],
    ["23 hours", 23 * 60 * 60_000, "23 h ago"],
    ["yesterday", 24 * 60 * 60_000, "yesterday"],
    ["a weekday within the week", 2 * 24 * 60 * 60_000, "Fri"],
    ["a date beyond the week", 7 * 24 * 60 * 60_000, "6 Sep"],
  ])("formats %s", (_name, delta, expected) => {
    expect(ago(now - delta, now)).toBe(expected);
  });

  test.each([
    ["seconds", 40_000, "40 s"],
    ["minutes", 2 * 60_000 + 5_000, "2 min"],
    ["hours", 60 * 60_000 + 4 * 60_000, "1 h"],
    ["a negative span as zero", -5_000, "0 s"],
  ])("formats an elapsed span in %s", (_name, ms, expected) => {
    expect(elapsed(ms)).toBe(expected);
  });

  test("formats the clock in hours and minutes", () => {
    const time = new Date(2026, 8, 13, 8, 41).getTime();

    expect(clock(time)).toBe("08:41");
  });

  test("stamps a turn with its day and time", () => {
    const time = new Date(2026, 8, 13, 16, 23).getTime();

    expect(stamp(time)).toBe("Sep 13, 16:23");
  });
});
