// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyChange,
  isCapabilityKey,
  MAX_DISABLED_CAPABILITIES,
  parseChange,
  parseSet,
  sameSet,
  WEB,
} from "../../src/shared/capabilities.ts";

describe("capability keys", () => {
  test("web is the one key this build knows", () => {
    expect(isCapabilityKey(WEB)).toBe(true);
    for (const key of ["", "Web", "web:", "mcp:abc", "skill:x", 7, null]) {
      expect(isCapabilityKey(key)).toBe(false);
    }
  });
});

describe("parseSet", () => {
  test("sorts and dedupes", () => {
    expect(parseSet([WEB, WEB], "set")).toEqual({ ok: true, set: [WEB] });
    expect(parseSet([], "set")).toEqual({ ok: true, set: [] });
  });
  test("refuses what is not a list of known keys", () => {
    for (const value of ["web", { web: true }, [7], ["nope"], null]) {
      expect(parseSet(value, "set").ok).toBe(false);
    }
  });
  test("refuses a list over the cap", () => {
    const many = Array.from(
      { length: MAX_DISABLED_CAPABILITIES + 1 },
      () => WEB,
    );
    expect(parseSet(many, "set").ok).toBe(false);
  });
});

describe("parseChange", () => {
  test("takes either side or none", () => {
    expect(parseChange({}, "c")).toEqual({ ok: true, change: {} });
    expect(parseChange({ disable: [WEB] }, "c")).toEqual({
      ok: true,
      change: { disable: [WEB] },
    });
    expect(parseChange({ enable: [WEB] }, "c")).toEqual({
      ok: true,
      change: { enable: [WEB] },
    });
  });
  test("refuses one key on both sides, another field, another shape", () => {
    expect(parseChange({ disable: [WEB], enable: [WEB] }, "c").ok).toBe(false);
    expect(parseChange({ off: [WEB] }, "c").ok).toBe(false);
    expect(parseChange([WEB], "c").ok).toBe(false);
    expect(parseChange(null, "c").ok).toBe(false);
    expect(parseChange({ disable: WEB }, "c").ok).toBe(false);
  });
});

describe("applyChange", () => {
  test("adds and removes over the set it is given", () => {
    expect(applyChange([], { disable: [WEB] })).toEqual({
      ok: true,
      set: [WEB],
    });
    expect(applyChange([WEB], { enable: [WEB] })).toEqual({
      ok: true,
      set: [],
    });
    expect(applyChange([WEB], { disable: [WEB] })).toEqual({
      ok: true,
      set: [WEB],
    });
  });
  test("an absent or empty change keeps the set", () => {
    expect(applyChange([WEB], undefined)).toEqual({ ok: true, set: [WEB] });
    expect(applyChange([WEB], {})).toEqual({ ok: true, set: [WEB] });
  });
});

test("sameSet compares sorted sets", () => {
  expect(sameSet([], [])).toBe(true);
  expect(sameSet([WEB], [WEB])).toBe(true);
  expect(sameSet([WEB], [])).toBe(false);
});
