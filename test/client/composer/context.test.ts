// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { k, readout } from "../../../src/client/composer/context.ts";

const usage = {
  promptTokens: 11_800,
  completionTokens: 700,
  cachedTokens: null,
  reasoningTokens: null,
  cost: null,
  contextLength: 131_072,
};

describe("context readout", () => {
  test("rounds to thousands", () => {
    expect(k(850)).toBe("850");
    expect(k(12_500)).toBe("13K");
    expect(k(131_072)).toBe("131K");
    expect(k(1_250_000)).toBe("1.3M");
  });

  test("shows prompt plus completion against the round's window", () => {
    const r = readout(usage)!;
    expect(r.text).toBe("13K / 131K");
    expect(r.percent).toBeCloseTo(9.54, 1);
    expect(r.title).toContain("12,500 of 131,072");
  });

  test("caps the bar at the window", () => {
    expect(readout({ ...usage, promptTokens: 200_000 })!.percent).toBe(100);
  });

  test("shows nothing before a round or without a window", () => {
    expect(readout(null)).toBeNull();
    expect(readout(undefined)).toBeNull();
    expect(readout({ ...usage, contextLength: null })).toBeNull();
    expect(readout({ ...usage, contextLength: 0 })).toBeNull();
  });
});
