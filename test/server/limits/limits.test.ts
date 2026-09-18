// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { withSaved } from "../../../src/client/views/admin/Tools.model.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  DEFAULT_LIMITS,
  LIMIT_DEFINITIONS,
  limitsArea,
} from "../../../src/server/limits/index.ts";
import { parseLimits } from "../../../src/server/limits/parse.ts";
import type { LimitsResponse } from "../../../src/shared/api/limits.ts";
import { testApp } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

describe("limits area", () => {
  test.each([
    {
      name: "scratchBytes",
      default: 16 * 1024 * 1024,
      min: 1024 * 1024,
      max: 64 * 1024 * 1024,
      unit: "bytes",
    },
    {
      name: "scratchFiles",
      default: 1000,
      min: 10,
      max: 10_000,
      unit: "count",
    },
    { name: "scratchIdleDays", default: 7, min: 1, max: 90, unit: "days" },
  ])("defines the scratch limit %p", ({ name, ...definition }) => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100 });
      expect(area.rows().find((row) => row.name === name)).toEqual({
        name,
        ...definition,
        scope: "knowledge",
        value: definition.default,
        changedAt: null,
      });
    } finally {
      db.close();
    }
  });

  test.each([
    { stored: 256 * 1024 * 1024, effective: 64 * 1024 * 1024 },
    { stored: 1, effective: 1024 * 1024 },
    { stored: 32 * 1024 * 1024, effective: 32 * 1024 * 1024 },
  ])(
    "uses the same bounded value for both reads: %p",
    ({ stored, effective }) => {
      const db = memoryDb();
      try {
        const area = limitsArea({ db, clock: () => 100 });
        area.store.set("knowledgeProjectBytes", stored, 50);
        expect(area.current().knowledgeProjectBytes).toBe(effective);
        expect(
          area.rows().find((row) => row.name === "knowledgeProjectBytes"),
        ).toMatchObject({
          value: effective,
          min: 1024 * 1024,
          max: 64 * 1024 * 1024,
          changedAt: 50,
        });
        expect(area.store.rows()).toEqual([
          { name: "knowledgeProjectBytes", value: stored, changedAt: 50 },
        ]);
      } finally {
        db.close();
      }
    },
  );

  test("saves another scope when a stored override exceeds its ceiling", async () => {
    const app = await testApp();
    try {
      const area = limitsArea({ db: app.db, clock: () => app.now.value });
      area.store.set("knowledgeProjectBytes", 256 * 1024 * 1024, 50);
      const admin = app.client();
      expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
      const response = await admin.call("GET", "/api/limits");
      expect(response.status).toBe(200);
      const { limits }: LimitsResponse = await response.json();
      const values = withSaved(limits, "send", { rounds: 12 });
      const saved = await admin.call("PUT", "/api/limits", {
        body: { values },
      });
      expect(saved.status).toBe(200);
      const body: LimitsResponse = await saved.json();
      expect(body.limits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "rounds", value: 12 }),
          expect.objectContaining({
            name: "knowledgeProjectBytes",
            value: 64 * 1024 * 1024,
          }),
        ]),
      );
      expect(area.current()).toEqual({
        ...DEFAULT_LIMITS,
        rounds: 12,
        knowledgeProjectBytes: 64 * 1024 * 1024,
      });
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("round-trips all nine knowledge caps with their scope and units", () => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100 });
      const values = {
        ...DEFAULT_LIMITS,
        knowledgeFileBytes: 4096,
        knowledgeFiles: 1,
        knowledgeProjectBytes: 1024 * 1024,
        knowledgeVersions: 1,
        knowledgeHistoryBytes: 1024 * 1024,
        knowledgeHistoryDays: 1,
        scratchBytes: 1024 * 1024,
        scratchFiles: 10,
        scratchIdleDays: 1,
      };
      expect(parseLimits({ values })).toEqual({ values });
      area.set(values, 100);
      expect(area.current()).toEqual(values);
      const rows = area.rows().filter((row) => row.scope === "knowledge");
      expect(rows).toHaveLength(9);
      expect(
        rows.find((row) => row.name === "knowledgeHistoryDays")?.unit,
      ).toBe("days");
      for (const row of rows) {
        expect(row.value).toBe(values[row.name]);
        expect(() =>
          parseLimits({ values: { ...values, [row.name]: row.min - 1 } }),
        ).toThrow(BadRequest);
        expect(() =>
          parseLimits({ values: { ...values, [row.name]: row.max + 1 } }),
        ).toThrow(BadRequest);
      }
    } finally {
      db.close();
    }
  });

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
