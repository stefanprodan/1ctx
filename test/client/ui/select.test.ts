// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  keyMove,
  pickOutcome,
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

describe("keyMove", () => {
  test("arrows step and wrap, Enter picks, any other key is not the list's", () => {
    expect(keyMove("ArrowDown", -1, 3)).toBe(0);
    expect(keyMove("ArrowDown", 2, 3)).toBe(0);
    expect(keyMove("ArrowUp", 0, 3)).toBe(2);
    expect(keyMove("ArrowUp", -1, 0)).toBe(-1);
    expect(keyMove("Enter", 1, 3)).toBe("pick");
    expect(keyMove("Escape", 1, 3)).toBeNull();
  });
});

describe("pickOutcome", () => {
  test("a click or Enter on a disabled option does nothing", () => {
    const off = { value: "fp4", label: "fp4", disabled: true, title: "why" };
    // Enter is a pick of the highlighted option, the same as a click
    expect(keyMove("Enter", 0, 1)).toBe("pick");
    expect(pickOutcome(off, "", false)).toBe("none");
    expect(pickOutcome(off, "fp4", false)).toBe("none");
    expect(pickOutcome(zones[2]!, "", true)).toBe("none");
    expect(pickOutcome(zones[2]!, "UTC", false)).toBe("close");
    expect(pickOutcome(zones[2]!, "", false)).toBe("change");
  });
});
