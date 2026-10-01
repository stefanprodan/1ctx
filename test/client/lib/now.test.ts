// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The day turn: the next midnight in a zone, and one timer to it that
// re-arms after each turn and stops on dispose.

import { expect, test } from "bun:test";
import {
  type DayClock,
  nextDayAt,
  onDayTurn,
} from "../../../src/client/lib/now.ts";

const at = (iso: string) => Date.parse(iso);

test("the next day starts at midnight in the zone", () => {
  expect(nextDayAt(at("2026-10-01T22:30:00Z"), "UTC")).toBe(
    at("2026-10-02T00:00:00Z"),
  );
  // Bucharest is UTC+3 in summer time
  expect(nextDayAt(at("2026-10-01T20:59:59Z"), "Europe/Bucharest")).toBe(
    at("2026-10-01T21:00:00Z"),
  );
  // the day summer time ends is 25 hours long
  expect(nextDayAt(at("2026-10-24T21:00:00Z"), "Europe/Bucharest")).toBe(
    at("2026-10-25T22:00:00Z"),
  );
  expect(nextDayAt(at("2026-10-01T23:00:00Z"), "Asia/Kolkata")).toBe(
    at("2026-10-02T18:30:00Z"),
  );
  // a zone that does not parse falls back to the browser's
  expect(nextDayAt(0, "Nowhere/Casey")).toBeGreaterThan(0);
});

test("one timer to each midnight, re-armed, cleared on dispose", () => {
  let now = at("2026-10-01T23:59:00Z");
  const timers: { due: number; fire: () => void }[] = [];
  const clock: DayClock = {
    now: () => now,
    after(ms, fire) {
      const timer = { due: now + ms, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  let turns = 0;
  const stop = onDayTurn("UTC", () => turns++, clock);
  expect(timers.map((t) => t.due)).toEqual([at("2026-10-02T00:00:00Z")]);
  now = timers[0]!.due;
  timers.shift()!.fire();
  expect(turns).toBe(1);
  expect(timers.map((t) => t.due)).toEqual([at("2026-10-03T00:00:00Z")]);
  stop();
  expect(timers).toEqual([]);
});
