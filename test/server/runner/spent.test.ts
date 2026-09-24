// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { spentTokens } from "../../../src/server/runner/round.ts";

const usage = (cachedTokens: number | null) => ({
  promptTokens: 4000,
  completionTokens: 1000,
  cachedTokens,
});

test("a round spends its fresh prompt, a tenth of its cached prompt and its completion", () => {
  expect(spentTokens(usage(3900))).toBe(1490);
});

test("a round without a cached count spends its whole prompt", () => {
  expect(spentTokens(usage(null))).toBe(5000);
  expect(spentTokens(usage(0))).toBe(5000);
});

test("a cached count above the prompt is clamped to the prompt", () => {
  expect(spentTokens(usage(5000))).toBe(1400);
});

test("a cached tenth rounds up", () => {
  expect(spentTokens(usage(15))).toBe(4000 - 15 + 2 + 1000);
});

test("a broken count spends nothing rather than giving the budget back", () => {
  expect(
    spentTokens({ promptTokens: -10, completionTokens: 5, cachedTokens: 0 }),
  ).toBe(5);
  expect(
    spentTokens({
      promptTokens: 100.7,
      completionTokens: Number.NaN,
      cachedTokens: -3,
    }),
  ).toBe(100);
});
