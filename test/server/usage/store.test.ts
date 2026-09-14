// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type UsageFields,
  UsageStore,
} from "../../../src/server/usage/store.ts";
import { memoryDb } from "../../helpers/db.ts";

function record(
  store: UsageStore,
  fields: {
    projectId: string;
    sendId: string;
    round?: number;
    now: number;
    prompt?: number;
    completion?: number;
  },
): void {
  const usage: UsageFields = {
    sendId: fields.sendId,
    sessionId: `${fields.sendId}-session`,
    projectId: fields.projectId,
    userId: "user",
    agentId: "agent",
    providerId: "provider",
    model: "model",
    round: fields.round ?? 1,
    promptTokens: fields.prompt ?? 2,
    completionTokens: fields.completion ?? 3,
    cachedTokens: null,
    reasoningTokens: null,
    cost: null,
    contextLength: null,
    now: fields.now,
  };
  store.record(usage);
}

describe("UsageStore.days", () => {
  test("places starts and the millisecond before boundaries", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    for (const [sendId, now] of [
      ["outside-before", -1],
      ["first-start", 0],
      ["before-second", 99],
      ["second-start", 100],
      ["before-until", 199],
      ["outside-after", 200],
    ] as const) {
      record(store, { projectId: "p1", sendId, now });
    }
    expect(store.days(["p1"], [0, 100], 200)).toEqual({
      total: { sends: 4, tokens: 20 },
      projects: [
        {
          projectId: "p1",
          usage: [
            { sends: 2, tokens: 10 },
            { sends: 2, tokens: 10 },
          ],
        },
      ],
    });
    db.close();
  });

  test("returns every project and zero-fills quiet days", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    record(store, { projectId: "p1", sendId: "one", now: 10 });
    record(store, { projectId: "p2", sendId: "two", now: 20 });
    expect(store.days(["p2", "p1", "p3"], [0, 100], 200)).toEqual({
      total: { sends: 2, tokens: 10 },
      projects: [
        {
          projectId: "p2",
          usage: [
            { sends: 1, tokens: 5 },
            { sends: 0, tokens: 0 },
          ],
        },
        {
          projectId: "p1",
          usage: [
            { sends: 1, tokens: 5 },
            { sends: 0, tokens: 0 },
          ],
        },
        {
          projectId: "p3",
          usage: [
            { sends: 0, tokens: 0 },
            { sends: 0, tokens: 0 },
          ],
        },
      ],
    });
    db.close();
  });

  test("counts several rounds from one send once in a day", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    record(store, {
      projectId: "p1",
      sendId: "send",
      round: 1,
      now: 10,
      prompt: 2,
      completion: 1,
    });
    record(store, {
      projectId: "p1",
      sendId: "send",
      round: 2,
      now: 20,
      prompt: 4,
      completion: 3,
    });
    expect(store.days(["p1"], [0], 100)).toEqual({
      total: { sends: 1, tokens: 10 },
      projects: [{ projectId: "p1", usage: [{ sends: 1, tokens: 10 }] }],
    });
    db.close();
  });

  test("counts a send on both days but once in the total", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    record(store, {
      projectId: "p1",
      sendId: "send",
      round: 1,
      now: 99,
    });
    record(store, {
      projectId: "p1",
      sendId: "send",
      round: 2,
      now: 100,
    });
    expect(store.days(["p1"], [0, 100], 200)).toEqual({
      total: { sends: 1, tokens: 10 },
      projects: [
        {
          projectId: "p1",
          usage: [
            { sends: 1, tokens: 5 },
            { sends: 1, tokens: 5 },
          ],
        },
      ],
    });
    db.close();
  });

  test("answers an empty project list without touching the database", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    db.close();
    expect(store.days([], [0, 100], 200)).toEqual({
      total: { sends: 0, tokens: 0 },
      projects: [],
    });
  });

  test("buckets negative instants without timestamp division", () => {
    const db = memoryDb();
    const store = new UsageStore(db);
    record(store, { projectId: "p1", sendId: "first", now: -200 });
    record(store, { projectId: "p1", sendId: "first-end", now: -101 });
    record(store, { projectId: "p1", sendId: "second", now: -100 });
    record(store, { projectId: "p1", sendId: "second-end", now: -1 });
    expect(store.days(["p1"], [-200, -100], 0)).toEqual({
      total: { sends: 4, tokens: 20 },
      projects: [
        {
          projectId: "p1",
          usage: [
            { sends: 2, tokens: 10 },
            { sends: 2, tokens: 10 },
          ],
        },
      ],
    });
    db.close();
  });
});
