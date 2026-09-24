// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  ago,
  clock,
  count,
  elapsed,
  stamp,
} from "../../../src/client/lib/format.ts";

describe("time formatting", () => {
  const now = new Date(2026, 8, 13, 12).getTime();

  test.each([
    ["59 seconds", 59_000, "59s ago"],
    ["1 minute", 60_000, "1m ago"],
    ["59 minutes", 59 * 60_000, "59m ago"],
    ["1 hour", 60 * 60_000, "1h ago"],
    ["23 hours", 23 * 60 * 60_000, "23h ago"],
    ["a day", 24 * 60 * 60_000, "1d ago"],
    ["six days", 6 * 24 * 60 * 60_000, "6d ago"],
    ["a week", 7 * 24 * 60 * 60_000, "1w ago"],
    ["three weeks", 27 * 24 * 60 * 60_000, "3w ago"],
    ["a date past four weeks", 28 * 24 * 60 * 60_000, "16 Aug"],
    ["a date in another year", 400 * 24 * 60 * 60_000, "9 Aug 2025"],
  ])("formats %s", (_name, delta, expected) => {
    expect(ago(now - delta, now)).toBe(expected);
  });

  test.each([
    ["units", 637, "637"],
    ["thousands", 12_400, "12.4K"],
    ["millions", 2_130_000, "2.13M"],
  ])("counts in %s", (_name, n, expected) => {
    expect(count(n)).toBe(expected);
  });

  test.each([
    ["seconds", 40_000, "40s"],
    ["minutes", 2 * 60_000 + 5_000, "2m"],
    ["hours", 60 * 60_000 + 4 * 60_000, "1h"],
    ["a negative span as zero", -5_000, "0s"],
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
