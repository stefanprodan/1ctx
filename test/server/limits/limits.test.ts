// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  DEFAULT_LIMITS,
  LIMIT_DEFINITIONS,
  limitsArea,
} from "../../../src/server/limits/index.ts";
import { parseLimits } from "../../../src/server/limits/parse.ts";
import { memoryDb } from "../../helpers/db.ts";

describe("limits area", () => {
  test("merges overrides and drops values restored to their defaults", () => {
    const db = memoryDb();
    const area = limitsArea({ db, clock: () => 100 });
    expect(area.current()).toEqual(DEFAULT_LIMITS);

    area.set(
      {
        ...DEFAULT_LIMITS,
        rounds: 11,
        callTimeoutMs: 3000,
      },
      100,
    );
    expect(area.current()).toEqual({
      ...DEFAULT_LIMITS,
      rounds: 11,
      callTimeoutMs: 3000,
    });
    expect(area.store.rows()).toEqual([
      { name: "rounds", value: 11, changedAt: 100 },
      { name: "callTimeoutMs", value: 3000, changedAt: 100 },
    ]);

    area.set({ ...DEFAULT_LIMITS, callTimeoutMs: 4000 }, 200);
    expect(area.store.rows()).toEqual([
      { name: "callTimeoutMs", value: 4000, changedAt: 200 },
    ]);
    expect(area.rows().find((row) => row.name === "rounds")).toMatchObject({
      value: DEFAULT_LIMITS.rounds,
      changedAt: null,
    });
    db.close();
  });

  test("round-trips both compaction limits", () => {
    const db = memoryDb();
    const area = limitsArea({ db, clock: () => 100 });
    area.set(
      {
        ...DEFAULT_LIMITS,
        contextReserve: 30_000,
        summaryMaxTokens: 8192,
      },
      100,
    );
    expect(area.current()).toMatchObject({
      contextReserve: 30_000,
      summaryMaxTokens: 8192,
    });
    expect(area.rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "contextReserve", value: 30_000 }),
        expect.objectContaining({ name: "summaryMaxTokens", value: 8192 }),
      ]),
    );
    db.close();
  });

  test("reset removes every override", () => {
    const db = memoryDb();
    const area = limitsArea({ db, clock: () => 100 });
    area.set({ ...DEFAULT_LIMITS, rounds: 12, maxSearches: 7 }, 100);
    area.reset();
    expect(area.store.rows()).toEqual([]);
    expect(area.current()).toEqual(DEFAULT_LIMITS);
    db.close();
  });
});

describe("parseLimits", () => {
  test("accepts each range boundary", () => {
    expect(
      parseLimits({
        values: {
          ...DEFAULT_LIMITS,
          rounds: LIMIT_DEFINITIONS.rounds.min,
          callTimeoutMs: LIMIT_DEFINITIONS.callTimeoutMs.max,
        },
      }),
    ).toEqual({
      values: {
        ...DEFAULT_LIMITS,
        rounds: LIMIT_DEFINITIONS.rounds.min,
        callTimeoutMs: LIMIT_DEFINITIONS.callTimeoutMs.max,
      },
    });
  });

  test.each([
    LIMIT_DEFINITIONS.rounds.min - 1,
    LIMIT_DEFINITIONS.rounds.max + 1,
    1.5,
  ])("refuses an invalid rounds value %p", (rounds) => {
    expect(() =>
      parseLimits({ values: { ...DEFAULT_LIMITS, rounds } }),
    ).toThrow(BadRequest);
  });

  test("refuses a compaction limit below its floor", () => {
    expect(() =>
      parseLimits({
        values: {
          ...DEFAULT_LIMITS,
          contextReserve: LIMIT_DEFINITIONS.contextReserve.min - 1,
        },
      }),
    ).toThrow(BadRequest);
  });

  test("refuses a missing or unknown limit name", () => {
    const missing: Partial<typeof DEFAULT_LIMITS> = { ...DEFAULT_LIMITS };
    delete missing.rounds;
    expect(() => parseLimits({ values: missing })).toThrow(BadRequest);
    expect(() =>
      parseLimits({ values: { ...DEFAULT_LIMITS, forever: 1 } }),
    ).toThrow(BadRequest);
  });
});
