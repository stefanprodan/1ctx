// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  KEEP_MS,
  MAX_KEPT,
  scanCache,
} from "../../../src/server/overview/cache.ts";

function controlled() {
  let now = 1_000;
  let runs = 0;
  const pending: {
    resolve: (v: number) => void;
    reject: (e: Error) => void;
  }[] = [];
  const cache = scanCache<number>({
    clock: () => now,
    run: () =>
      new Promise<number>((resolve, reject) => {
        runs++;
        pending.push({ resolve, reject });
      }),
  });
  return {
    cache,
    pending,
    get runs() {
      return runs;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the scan cache", () => {
  test("requests during a scan wait for the same answer", async () => {
    const c = controlled();
    const first = c.cache.get();
    const second = c.cache.get();
    expect(c.runs).toBe(1);
    c.pending[0]!.resolve(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
  });

  test("keeps an answer a minute and reads again after it", async () => {
    const c = controlled();
    const first = c.cache.get();
    c.pending[0]!.resolve(1);
    await first;
    c.advance(KEEP_MS - 1);
    expect(await c.cache.get()).toBe(1);
    expect(c.runs).toBe(1);
    c.advance(1);
    const again = c.cache.get();
    expect(c.runs).toBe(2);
    c.pending[1]!.resolve(2);
    expect(await again).toBe(2);
  });

  test("keeps an answer per key and drops one past its minute", async () => {
    const keys: string[] = [];
    let now = 1_000;
    const cache = scanCache<string>({
      clock: () => now,
      run: (key) => {
        keys.push(key);
        return Promise.resolve(`${key}!`);
      },
    });
    expect(await cache.get("UTC\n7")).toBe("UTC\n7!");
    expect(await cache.get("UTC\n7")).toBe("UTC\n7!");
    expect(await cache.get("UTC\n30")).toBe("UTC\n30!");
    expect(keys).toEqual(["UTC\n7", "UTC\n30"]);
    now += KEEP_MS;
    await cache.get("UTC\n30");
    await cache.get("UTC\n7");
    expect(keys).toEqual(["UTC\n7", "UTC\n30", "UTC\n30", "UTC\n7"]);
  });

  test("keeps at most MAX_KEPT answers, the oldest out", async () => {
    const keys: string[] = [];
    let now = 1_000;
    const cache = scanCache<string>({
      clock: () => {
        now += 1;
        return now;
      },
      run: (key) => {
        keys.push(key);
        return Promise.resolve(key);
      },
    });
    for (let i = 0; i < MAX_KEPT + 1; i++) await cache.get(`k${i}`);
    expect(keys).toHaveLength(MAX_KEPT + 1);
    await cache.get("k1");
    expect(keys).toHaveLength(MAX_KEPT + 1);
    await cache.get("k0");
    expect(keys).toHaveLength(MAX_KEPT + 2);
  });

  test("keeps nothing from a failed scan", async () => {
    const c = controlled();
    const failed = c.cache.get();
    c.pending[0]!.reject(new Error("no file"));
    await expect(failed).rejects.toThrow("no file");
    const retried = c.cache.get();
    expect(c.runs).toBe(2);
    c.pending[1]!.resolve(3);
    expect(await retried).toBe(3);
  });
});
