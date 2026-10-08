// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  DEFAULT_LIMITS,
  LIMIT_DEFINITIONS,
  limitsArea,
  sendsRunningDefault,
} from "../../../src/server/limits/index.ts";
import { parseLimits } from "../../../src/server/limits/parse.ts";
import type { LimitsResponse } from "../../../src/shared/api/limits.ts";
import { LIMIT_NAMES } from "../../../src/shared/contracts/limit.ts";
import { testApp } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

const budgetLimits = [
  {
    name: "childrenAtOnce",
    default: 2,
    min: 1,
    max: 4,
    unit: "count",
    scope: "send",
  },
  {
    name: "childrenPerSend",
    default: 4,
    min: 1,
    max: 16,
    unit: "count",
    scope: "send",
  },
  {
    name: "childAnswerChars",
    default: 12_000,
    min: 1000,
    max: 16_000,
    unit: "chars",
    scope: "send",
  },
  {
    name: "rounds",
    default: 100,
    min: 1,
    max: 500,
    unit: "count",
    scope: "send",
  },
  {
    name: "toolWorkTokens",
    default: 1_000_000,
    min: 10_000,
    max: 10_000_000,
    unit: "tokens",
    scope: "send",
  },
  {
    name: "maxBashCalls",
    default: 100,
    min: 1,
    max: 1000,
    unit: "count",
    scope: "call",
  },
  {
    name: "sendsPerUser",
    default: 4,
    min: 1,
    max: 16,
    unit: "count",
    scope: "sends",
  },
  {
    name: "sendsPerProject",
    default: 16,
    min: 4,
    max: 64,
    unit: "count",
    scope: "sends",
  },
  {
    name: "contextReserve",
    default: 20_000,
    min: 1000,
    max: 200_000,
    unit: "tokens",
    scope: "send",
  },
  {
    name: "summaryMaxTokens",
    default: 4096,
    min: 1000,
    max: 32_000,
    unit: "tokens",
    scope: "send",
  },
  {
    name: "scratchBytes",
    default: 16 * 1024 * 1024,
    min: 1024 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  {
    name: "scratchFiles",
    default: 1000,
    min: 10,
    max: 10_000,
    unit: "count",
    scope: "knowledge",
  },
  {
    name: "scratchIdleDays",
    default: 7,
    min: 1,
    max: 90,
    unit: "days",
    scope: "knowledge",
  },
  {
    name: "uploadBytes",
    default: 16 * 1024 * 1024,
    min: 1024 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "knowledge",
  },
  {
    name: "uploadFiles",
    default: 1000,
    min: 10,
    max: 10_000,
    unit: "count",
    scope: "knowledge",
  },
  {
    name: "repoBytes",
    default: 256 * 1024 * 1024,
    min: 1024 * 1024,
    max: 2 * 1024 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
  {
    name: "repoFiles",
    default: 50_000,
    min: 100,
    max: 500_000,
    unit: "count",
    scope: "repos",
  },
  {
    name: "repoFileBytes",
    default: 4 * 1024 * 1024,
    min: 64 * 1024,
    max: 64 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
  {
    name: "repoCacheBytes",
    default: 10 * 1024 * 1024 * 1024,
    min: 1024 * 1024 * 1024,
    max: 1024 * 1024 * 1024 * 1024,
    unit: "bytes",
    scope: "repos",
  },
] as const;

describe("limits area", () => {
  test.each([...budgetLimits])(
    "defines and round-trips the limit %p",
    ({ name, ...definition }) => {
      const db = memoryDb();
      try {
        const area = limitsArea({ db, clock: () => 100, cores: 1 });
        expect(LIMIT_NAMES).toContain(name);
        expect(LIMIT_DEFINITIONS[name]).toEqual(definition);
        expect(DEFAULT_LIMITS[name]).toBe(definition.default);
        expect(area.rows().find((row) => row.name === name)).toEqual({
          name,
          ...definition,
          value: definition.default,
          changedAt: null,
        });
        for (const value of [definition.min, definition.max]) {
          const { values } = parseLimits({
            values: { ...DEFAULT_LIMITS, [name]: value },
          });
          area.set(values, 100);
          expect(area.current()[name]).toBe(value);
          expect(area.rows().find((row) => row.name === name)).toMatchObject({
            value,
            changedAt: 100,
          });
          expect(area.store.rows()).toEqual([{ name, value, changedAt: 100 }]);
        }
        for (const [stored, effective] of [
          [definition.min - 1, definition.min],
          [definition.max + 1, definition.max],
        ] as const) {
          expect(() =>
            parseLimits({ values: { ...DEFAULT_LIMITS, [name]: stored } }),
          ).toThrow(BadRequest);
          area.store.set(name, stored, 200);
          expect(area.current()[name]).toBe(effective);
          expect(area.rows().find((row) => row.name === name)).toMatchObject({
            value: effective,
            changedAt: 200,
          });
          const { values } = parseLimits({
            values: { [name]: effective },
          });
          area.set(values, 300);
          expect(area.store.rows()).toEqual([
            { name, value: effective, changedAt: 300 },
          ]);
        }
        expect(() =>
          parseLimits({
            values: { ...DEFAULT_LIMITS, [name]: definition.min + 0.5 },
          }),
        ).toThrow(BadRequest);
        area.set(DEFAULT_LIMITS, 400);
        expect(area.current()[name]).toBe(definition.default);
        expect(area.store.rows()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  test("lists every limit once in its scope with the runtime defaults", () => {
    const db = memoryDb();
    try {
      const rows = limitsArea({ db, clock: () => 100, cores: 1 }).rows();
      expect(rows).toHaveLength(51);
      expect(new Set(rows.map((row) => row.name)).size).toBe(51);
      expect(rows.filter((row) => row.scope === "send")).toHaveLength(15);
      expect(rows.filter((row) => row.scope === "call")).toHaveLength(9);
      expect(rows.filter((row) => row.scope === "knowledge")).toHaveLength(13);
      expect(rows.filter((row) => row.scope === "sends")).toHaveLength(5);
      expect(rows.filter((row) => row.scope === "visuals")).toHaveLength(3);
      expect(rows.filter((row) => row.scope === "chats")).toHaveLength(2);
      expect(rows.filter((row) => row.scope === "repos")).toHaveLength(4);
      expect(DEFAULT_LIMITS).toMatchObject({
        rounds: 100,
        toolWorkTokens: 1_000_000,
      });
      expect(DEFAULT_LIMITS.maxBashCalls).toBe(100);
    } finally {
      db.close();
    }
  });

  test("sendsRunning holds 4 to 256, 64 by default, never below the project's cap", () => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100, cores: 1 });
      expect(LIMIT_DEFINITIONS.sendsRunning).toEqual({
        default: 64,
        min: 4,
        max: 256,
        unit: "count",
        scope: "sends",
      });
      const low = { sendsPerUser: 1, sendsPerProject: 4, sendsRunning: 4 };
      area.set({ ...DEFAULT_LIMITS, ...low }, 100);
      expect(area.current()).toMatchObject(low);
      area.set({ ...DEFAULT_LIMITS, sendsRunning: 256 }, 110);
      expect(area.current().sendsRunning).toBe(256);
    } finally {
      db.close();
    }
  });

  test.each([
    [1, 64],
    [2, 96],
    [4, 192],
    [5, 240],
    [6, 256],
    [64, 256],
    [0, 64],
    [-2, 64],
    [3.9, 144],
    [Number.NaN, 64],
  ])("sendsRunning's default on %p cores is %p", (cores, expected) => {
    expect(sendsRunningDefault(cores)).toBe(expected);
  });

  test("a 4-core instance defaults sendsRunning to 192 and drops an override of 192", () => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100, cores: 4 });
      expect(area.current().sendsRunning).toBe(192);
      expect(area.rows().find((row) => row.name === "sendsRunning")).toEqual({
        name: "sendsRunning",
        value: 192,
        default: 192,
        min: 4,
        max: 256,
        unit: "count",
        scope: "sends",
        changedAt: null,
      });
      area.set({ sendsRunning: 64 }, 100);
      expect(area.store.rows()).toEqual([
        { name: "sendsRunning", value: 64, changedAt: 100 },
      ]);
      expect(area.current().sendsRunning).toBe(64);
      area.set({ sendsRunning: 192 }, 110);
      expect(area.store.rows()).toEqual([]);
      area.set({ sendsRunning: 100 }, 120);
      area.reset();
      expect(area.current().sendsRunning).toBe(192);
    } finally {
      db.close();
    }
  });

  test.each([0, 1])(
    "on %p cores the project's cap fits under the process default",
    (cores) => {
      const db = memoryDb();
      try {
        const area = limitsArea({ db, clock: () => 100, cores });
        const top = LIMIT_DEFINITIONS.sendsPerProject.max;
        expect(top).toBeLessThanOrEqual(area.current().sendsRunning);
        area.set({ sendsPerProject: top }, 100);
        expect(area.current().sendsPerProject).toBe(top);
        expect(() => area.set({ sendsRunning: top - 1 }, 110)).toThrow(
          new BadRequest("sendsPerProject must not be above sendsRunning"),
        );
      } finally {
        db.close();
      }
    },
  );

  test("the limits route answers the instance's cores", async () => {
    const app = await testApp({ cores: 4 });
    try {
      const admin = app.client();
      expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
      const res = await admin.call("GET", "/api/limits");
      const body = (await res.json()) as LimitsResponse;
      expect(
        body.limits.find((row) => row.name === "sendsRunning"),
      ).toMatchObject({ value: 192, default: 192, changedAt: null });
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test.each([
    [
      { sendsPerUser: 16, sendsPerProject: 8 },
      "sendsPerUser must not be above sendsPerProject",
    ],
    [
      { sendsPerProject: 32, sendsRunning: 16 },
      "sendsPerProject must not be above sendsRunning",
    ],
  ])(
    "a write that breaks the order is refused and writes nothing",
    (values, error) => {
      const db = memoryDb();
      try {
        const area = limitsArea({ db, clock: () => 100, cores: 1 });
        expect(() => area.set({ ...DEFAULT_LIMITS, ...values }, 100)).toThrow(
          new BadRequest(error),
        );
        expect(area.store.rows()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  test("a write of one cap is ordered against the others' overrides", () => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100, cores: 1 });
      area.set({ sendsPerProject: 8, sendsPerUser: 8 }, 100);
      expect(() => area.set({ sendsPerProject: 6 }, 110)).toThrow(BadRequest);
      expect(() => area.set({ sendsPerUser: 9 }, 110)).toThrow(BadRequest);
      area.set({ sendsPerUser: 2, sendsPerProject: 6 }, 120);
      expect(area.current()).toMatchObject({
        sendsPerUser: 2,
        sendsPerProject: 6,
      });
    } finally {
      db.close();
    }
  });

  test("a write that moves a send cap calls the port once, any other none", () => {
    const db = memoryDb();
    try {
      let calls = 0;
      const area = limitsArea({
        db,
        clock: () => 100,
        cores: 1,
        wake: () => calls++,
      });
      area.set({ ...DEFAULT_LIMITS, rounds: 20 }, 100);
      expect(calls).toBe(0);
      area.set({ ...DEFAULT_LIMITS, rounds: 20, sendsPerUser: 6 }, 110);
      expect(calls).toBe(1);
      area.set({ ...DEFAULT_LIMITS, rounds: 30, sendsPerUser: 6 }, 120);
      expect(calls).toBe(1);
      area.set({ ...DEFAULT_LIMITS, sendsRunning: 40, sendsPerUser: 6 }, 130);
      expect(calls).toBe(2);
      area.set(
        {
          ...DEFAULT_LIMITS,
          sendsRunning: 40,
          sendsPerUser: 6,
          sendsPerProject: 20,
        },
        140,
      );
      expect(calls).toBe(3);
      area.reset();
      expect(calls).toBe(4);
      area.reset();
      expect(calls).toBe(4);
    } finally {
      db.close();
    }
  });

  test("saves the send, tool-work and bash limits through the full-set PUT", async () => {
    const app = await testApp();
    try {
      const admin = app.client();
      expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
      const saved = await admin.call("PUT", "/api/limits", {
        body: {
          values: {
            ...DEFAULT_LIMITS,
            rounds: 250,
            toolWorkTokens: 750_000,
            maxBashCalls: 200,
            sendsPerUser: 2,
            sendsPerProject: 8,
            sendsRunning: 8,
          },
        },
      });
      expect(saved.status).toBe(200);
      const body: LimitsResponse = await saved.json();
      expect(body.limits).toHaveLength(51);
      expect(body.limits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "rounds", value: 250 }),
          expect.objectContaining({
            name: "toolWorkTokens",
            value: 750_000,
            scope: "send",
          }),
          expect.objectContaining({
            name: "maxBashCalls",
            value: 200,
            scope: "call",
          }),
        ]),
      );
      expect(body.limits.filter((row) => row.scope === "sends")).toEqual([
        expect.objectContaining({ name: "sendsPerUser", value: 2 }),
        expect.objectContaining({ name: "sendsPerProject", value: 8 }),
        expect.objectContaining({ name: "sendsRunning", value: 8 }),
        expect.objectContaining({ name: "queuedPerUser", value: 8 }),
        expect.objectContaining({ name: "queuedMinutes", value: 60 }),
      ]);
      const loaded = await admin.call("GET", "/api/limits");
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toEqual(body);
      const one = await admin.call("PUT", "/api/limits", {
        body: { values: { sendsPerUser: 3 } },
      });
      expect(one.status).toBe(200);
      const sends = ((await one.json()) as typeof body).limits.filter(
        (row) => row.scope === "sends",
      );
      expect(sends).toEqual([
        expect.objectContaining({ name: "sendsPerUser", value: 3 }),
        expect.objectContaining({ name: "sendsPerProject", value: 8 }),
        expect.objectContaining({ name: "sendsRunning", value: 8 }),
        expect.objectContaining({ name: "queuedPerUser", value: 8 }),
        expect.objectContaining({ name: "queuedMinutes", value: 60 }),
      ]);
      const unordered = await admin.call("PUT", "/api/limits", {
        body: { values: { sendsPerUser: 9 } },
      });
      expect(unordered.status).toBe(400);
      expect(await unordered.json()).toEqual({
        error: "sendsPerUser must not be above sendsPerProject",
      });
      const refused = await admin.call("PUT", "/api/limits", {
        body: { values: {} },
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: "values must name a limit",
      });
      const over = await admin.call("PUT", "/api/limits", {
        body: { values: { ...DEFAULT_LIMITS, sendsRunning: 257 } },
      });
      expect(over.status).toBe(400);
      expect(await over.json()).toEqual({
        error: "sendsRunning must be between 4 and 256",
      });
    } finally {
      await app.shutdown();
      app.db.close();
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
        const area = limitsArea({ db, clock: () => 100, cores: 1 });
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

  test("holds every token limit to whole thousands", () => {
    for (const entry of Object.values(LIMIT_DEFINITIONS)) {
      if (entry.unit !== "tokens") continue;
      expect(entry.min % 1000).toBe(0);
      expect(entry.max % 1000).toBe(0);
    }
  });

  test.each([
    { stored: 256, effective: 1000 },
    { stored: 32_768, effective: 32_000 },
  ])(
    "reads an old summary override inside the new range: %p",
    ({ stored, effective }) => {
      const db = memoryDb();
      try {
        const area = limitsArea({ db, clock: () => 100, cores: 1 });
        area.store.set("summaryMaxTokens", stored, 50);
        expect(area.current().summaryMaxTokens).toBe(effective);
        expect(
          area.rows().find((row) => row.name === "summaryMaxTokens"),
        ).toMatchObject({ value: effective, changedAt: 50 });
        expect(() =>
          parseLimits({ values: { summaryMaxTokens: stored } }),
        ).toThrow("summaryMaxTokens must be between 1000 and 32000");
      } finally {
        db.close();
      }
    },
  );

  test("saves another scope when a stored override exceeds its ceiling", async () => {
    const app = await testApp();
    try {
      const area = limitsArea({
        db: app.db,
        clock: () => app.now.value,
        cores: 1,
      });
      area.store.set("knowledgeProjectBytes", 256 * 1024 * 1024, 50);
      const admin = app.client();
      expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
      const response = await admin.call("GET", "/api/limits");
      expect(response.status).toBe(200);
      const { limits }: LimitsResponse = await response.json();
      expect(limits.length).toBeGreaterThan(0);
      const saved = await admin.call("PUT", "/api/limits", {
        body: { values: { rounds: 12 } },
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

  test("round-trips all thirteen knowledge caps with their scope and units", () => {
    const db = memoryDb();
    try {
      const area = limitsArea({ db, clock: () => 100, cores: 1 });
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
        uploadBytes: 1024 * 1024,
        uploadFiles: 10,
        mcpKeptBytes: 1024 * 1024,
        mcpKeptFiles: 10,
      };
      expect(parseLimits({ values })).toEqual({ values });
      area.set(values, 100);
      expect(area.current()).toEqual(values);
      const rows = area.rows().filter((row) => row.scope === "knowledge");
      expect(rows).toHaveLength(13);
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
    const area = limitsArea({ db, clock: () => 100, cores: 1 });
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
    const area = limitsArea({ db, clock: () => 100, cores: 1 });
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
    const area = limitsArea({ db, clock: () => 100, cores: 1 });
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

  test("takes some limits, and refuses none or an unknown name", () => {
    expect(parseLimits({ values: { rounds: 20 } })).toEqual({
      values: { rounds: 20 },
    });
    expect(() => parseLimits({ values: {} })).toThrow(BadRequest);
    expect(() =>
      parseLimits({ values: { ...DEFAULT_LIMITS, forever: 1 } }),
    ).toThrow(BadRequest);
  });
});
