// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MAX_KEYS, RateLimit } from "../../../src/server/access/ratelimit.ts";

describe("RateLimit", () => {
  test("allows the limit, refuses the next, forgets after the window", () => {
    const limit = new RateLimit(3, 1000);
    expect(limit.hit("a", 0)).toBe(true);
    expect(limit.hit("a", 100)).toBe(true);
    expect(limit.hit("a", 200)).toBe(true);
    expect(limit.hit("a", 300)).toBe(false);
    expect(limit.hit("b", 300)).toBe(true);
    // the refused hit counts, so a flood stays blocked
    expect(limit.hit("a", 900)).toBe(false);
    expect(limit.hit("a", 1301)).toBe(true);
    expect(limit.hit("a", 2400)).toBe(true);
  });
});

describe("RateLimit under load", () => {
  test("a flood on one key costs one counter", () => {
    const limit = new RateLimit(3, 1000);
    for (let i = 0; i < 100_000; i++) limit.hit("a", i % 900);
    expect(limit.size).toBe(1);
    expect(limit.hit("a", 950)).toBe(false);
    expect(limit.hit("a", 1000)).toBe(true);
  });

  test("a flood of keys is capped, ended windows first", () => {
    const limit = new RateLimit(3, 1000);
    for (let i = 0; i < MAX_KEYS; i++) limit.hit(`old-${i}`, 0);
    // past the window the old keys are the ones to go
    for (let i = 0; i < 100; i++) limit.hit(`new-${i}`, 1000);
    expect(limit.size).toBe(100);
    // inside a window the oldest go, and the cap holds
    for (let i = 0; i < MAX_KEYS + 50; i++) limit.hit(`k-${i}`, 1500);
    expect(limit.size).toBe(MAX_KEYS);
  });
});
