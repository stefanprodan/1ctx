// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { revealBy } from "../../../src/client/lib/scroll.ts";

const view = { top: 64, bottom: 900 };

describe("revealBy", () => {
  test("a row that fits in view stays", () => {
    expect(revealBy({ top: 200, bottom: 600 }, view)).toBe(0);
  });

  test("a row past the foot scrolls up until its foot shows", () => {
    expect(revealBy({ top: 700, bottom: 1000 }, view)).toBe(100);
  });

  test("a row taller than the view stops with its head at the top", () => {
    expect(revealBy({ top: 700, bottom: 2000 }, view)).toBe(636);
  });

  test("a head above the view comes down to the top", () => {
    expect(revealBy({ top: -310, bottom: 1000 }, view)).toBe(-374);
    expect(revealBy({ top: 10, bottom: 300 }, view)).toBe(-54);
  });
});
