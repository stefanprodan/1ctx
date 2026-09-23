// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { nextFire } from "../../../src/server/automations/schedule.ts";
import { newestPast, Waits } from "../../../src/server/automations/waits.ts";
import { collectLogs } from "../../helpers/app.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// the walk the search replaces, the answer it must give
function walked(schedule: string, tz: string, dueAt: number, now: number) {
  let newest: number | null = null;
  let next = nextFire(schedule, tz, dueAt);
  while (next <= now) {
    newest = next;
    next = nextFire(schedule, tz, next);
  }
  return newest;
}

const waits = () => new Waits(collectLogs().logFactory("automations"));

describe("newestPast", () => {
  const due = Date.UTC(2026, 8, 14, 9);
  const cases: [string, string, number][] = [
    ["*/5 * * * *", "UTC", 0],
    ["*/5 * * * *", "UTC", 4 * 60_000],
    ["*/5 * * * *", "UTC", 5 * 60_000],
    ["*/5 * * * *", "UTC", 3 * HOUR + 7 * 60_000],
    ["0 9 * * 1-5", "Europe/Bucharest", 10 * DAY + 5 * HOUR],
    ["30 2 * * *", "Europe/Bucharest", 40 * DAY],
    ["0 0 1 * *", "America/New_York", 400 * DAY],
    // the spring gap and the autumn repeat of 2026 in Bucharest
    ["30 3 * * *", "Europe/Bucharest", 200 * DAY],
    ["*/5 3 * * *", "Europe/Bucharest", 60 * DAY],
    ["0 12 29 2 *", "UTC", 2000 * DAY],
  ];
  for (const [schedule, tz, down] of cases) {
    test(`${schedule} in ${tz}, ${down / 60_000} minutes on`, () => {
      expect(newestPast(schedule, tz, due, due + down)).toBe(
        walked(schedule, tz, due, due + down),
      );
    });
  }

  test("a year of five-minute fires asks a few dozen times", () => {
    const now = due + 365 * DAY;
    let asked = 0;
    const counted: typeof nextFire = (schedule, tz, from) => {
      asked++;
      return nextFire(schedule, tz, from);
    };
    const newest = newestPast("*/5 * * * *", "UTC", due, now, counted);
    expect(newest).toBe(now - (now % (5 * 60_000)));
    // the walk asks 105,000 times
    expect(asked).toBeLessThan(40);
  });
});

describe("Waits", () => {
  test("a wake during the attempt leaves the pool open", () => {
    const w = waits();
    const seen = w.generation;
    w.wake();
    w.block("a1", { wait: "user", dueAt: 1, ownerId: "u1" }, seen, 0);
    w.block("a2", { wait: "process", dueAt: 1, ownerId: "u2" }, seen, 0);
    expect(w.ownerFull("u1")).toBe(false);
    expect(w.processFull).toBe(false);
    expect(w.any).toBe(false);
  });

  test("a block holds until a wake or a pass interval", () => {
    const w = waits();
    w.block("a1", { wait: "user", dueAt: 1, ownerId: "u1" }, w.generation, 0);
    expect(w.ownerFull("u1")).toBe(true);
    w.expire(59_999, 60_000);
    expect(w.ownerFull("u1")).toBe(true);
    w.expire(60_000, 60_000);
    expect(w.any).toBe(false);
    w.block(
      "a1",
      { wait: "process", dueAt: 1, ownerId: "u1" },
      w.generation,
      0,
    );
    expect(w.processFull).toBe(true);
    w.wake();
    expect(w.any).toBe(false);
  });

  test("a wake starts the interval again for the next block", () => {
    const w = waits();
    w.block("a1", { wait: "user", dueAt: 1, ownerId: "u1" }, w.generation, 0);
    w.wake();
    w.block(
      "a1",
      { wait: "user", dueAt: 1, ownerId: "u1" },
      w.generation,
      50_000,
    );
    w.expire(60_000, 60_000);
    expect(w.ownerFull("u1")).toBe(true);
    w.expire(110_000, 60_000);
    expect(w.any).toBe(false);
  });

  test("a wait is logged once per occurrence, and forgotten once not due", () => {
    const logs = collectLogs();
    const w = new Waits(logs.logFactory("automations"));
    const wait = { wait: "user" as const, dueAt: 1, ownerId: "u1" };
    w.block("a1", wait, w.generation, 0);
    w.block("a1", wait, w.generation, 0);
    w.prune(new Set());
    w.block("a1", wait, w.generation, 0);
    expect(logs.events.filter((e) => e.msg === "wait")).toHaveLength(2);
  });
});
