// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  stepHighlight,
} from "../../../src/client/ui/Select.model.ts";

const zones = [
  {
    value: "America/New_York",
    label: "America/New_York",
    detail: "GMT-4",
    keywords: "St. Louis",
  },
  {
    value: "Europe/Bucharest",
    label: "Europe/Bucharest",
    detail: "GMT+3 · România",
  },
  { value: "UTC", label: "UTC", detail: "GMT" },
];

describe("filterOptions", () => {
  test("a blank query keeps every option", () => {
    expect(filterOptions(zones, "  ")).toBe(zones);
  });

  test("words match every field with accents and punctuation folded", () => {
    const labels = (q: string) => filterOptions(zones, q).map((o) => o.value);
    expect(labels("new york")).toEqual(["America/New_York"]);
    expect(labels("europe bucha")).toEqual(["Europe/Bucharest"]);
    expect(labels("BUCHAREST")).toEqual(["Europe/Bucharest"]);
    expect(labels("gmt 3 romania")).toEqual(["Europe/Bucharest"]);
    expect(labels("st louis")).toEqual(["America/New_York"]);
    expect(labels("york europe")).toEqual([]);
  });
});

describe("the highlight", () => {
  test("opens on the picked row or the first row", () => {
    expect(initialHighlight(zones, "Europe/Bucharest")).toBe(1);
    expect(initialHighlight(zones, "gone")).toBe(0);
    expect(initialHighlight([], "gone")).toBe(-1);
  });

  test("stays valid when filtering or an option update shrinks the list", () => {
    expect(clampHighlight(4, 2)).toBe(0);
    expect(clampHighlight(1, 2)).toBe(1);
    expect(clampHighlight(-1, 2)).toBe(-1);
    expect(clampHighlight(0, 0)).toBe(-1);
  });

  test("moves and wraps, and starts at an end", () => {
    expect(stepHighlight(0, 3, 1)).toBe(1);
    expect(stepHighlight(2, 3, 1)).toBe(0);
    expect(stepHighlight(0, 3, -1)).toBe(2);
    expect(stepHighlight(-1, 3, 1)).toBe(0);
    expect(stepHighlight(-1, 3, -1)).toBe(2);
    expect(stepHighlight(1, 0, 1)).toBe(-1);
    expect(stepHighlight(0, 0, 1)).toBe(-1);
    expect(stepHighlight(0, 0, -1)).toBe(-1);
  });

  test("a list that is never empty wraps as the composer's commands do", () => {
    expect(stepHighlight(0, 3, 1)).toBe(1);
    expect(stepHighlight(2, 3, 1)).toBe(0);
    expect(stepHighlight(0, 3, -1)).toBe(2);
  });
});
