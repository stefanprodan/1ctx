// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type ActivityCell,
  type ActivityLevel,
  activityLevel,
  activityModel,
  dayHint,
  fitWeeks,
  gridAriaLabel,
  lastWeekColumns,
  monthLabels,
  moveSelection,
  projectAnswer,
  projectStrip,
  sendsPopulation,
  stripAriaLabel,
  sumDays,
  totalHint,
  type WeekColumn,
  weekColumns,
} from "../../../src/client/views/projects/Activity.model.ts";
import type {
  DaysUsageResponse,
  DayUsage,
} from "../../../src/shared/api/usage.ts";

function dayStrings(start: string, length: number): string[] {
  const date = new Date(`${start}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const day = new Date(date.getTime() + index * 86_400_000);
    return day.toISOString().slice(0, 10);
  });
}

function usage(sends: number[], tokens = sends): DayUsage[] {
  return sends.map((value, index) => ({
    sends: value,
    tokens: tokens[index] ?? 0,
  }));
}

function answer(
  days: string[],
  projects: { projectId: string; usage: DayUsage[] }[],
  total = { sends: 0, tokens: 0 },
): DaysUsageResponse {
  return { since: 0, until: 1, days, total, projects };
}

function cell(day: string): ActivityCell {
  return { day, sends: 0, tokens: 0, level: 0 };
}

describe("activity levels", () => {
  const fixtures: { sends: number[]; levels: ActivityLevel[] }[] = [
    { sends: [0, 0, 0], levels: [0, 0, 0] },
    { sends: [5], levels: [4] },
    { sends: [1, 5], levels: [2, 4] },
    { sends: [1, 2, 3], levels: [2, 3, 4] },
    { sends: [1, 2, 3, 4], levels: [1, 2, 3, 4] },
    { sends: [2, 2, 5], levels: [3, 3, 4] },
    { sends: [3, 3, 3, 3], levels: [4, 4, 4, 4] },
    { sends: [1, 1, 1, 100], levels: [3, 3, 3, 4] },
  ];

  for (const fixture of fixtures) {
    test(`${fixture.sends.join(",")} gives ${fixture.levels.join(",")}`, () => {
      const rows = usage(fixture.sends);
      const population = sendsPopulation(rows);
      expect(rows.map((day) => activityLevel(day.sends, population))).toEqual(
        fixture.levels,
      );
    });
  }

  test("a population comes sorted, so the rank search holds", () => {
    const rows = usage([4, 0, 1, 3, 1]);
    expect(sendsPopulation(rows)).toEqual([1, 1, 3, 4]);
    expect(rows.map((day) => activityLevel(day.sends, [1, 1, 3, 4]))).toEqual([
      4, 0, 2, 3, 2,
    ]);
  });

  test("strips rank against every project's days, not the summed ones", () => {
    const days = ["2026-09-13", "2026-09-14"];
    const body = answer(days, [
      { projectId: "p1", usage: usage([0, 1]) },
      { projectId: "p2", usage: usage([2, 4]) },
    ]);
    const model = activityModel(body);

    expect(model.population).toEqual([2, 5]);
    expect(model.rowPopulation).toEqual([1, 2, 4]);
    // against the summed days both projects' today would sit at level 1
    expect(activityLevel(4, model.population)).toBe(2);
    expect(
      projectStrip(body, "p1", model.rowPopulation).map((c) => c.level),
    ).toEqual([0, 2]);
    expect(
      projectStrip(body, "p2", model.rowPopulation).map((c) => c.level),
    ).toEqual([3, 4]);
    // a value below every ranked one still shows
    expect(activityLevel(1, [5])).toBe(1);
  });
});

describe("activity shape", () => {
  test("sums every project's sends and tokens by day", () => {
    const body = answer(dayStrings("2026-09-14", 3), [
      { projectId: "p1", usage: usage([1, 0, 3], [10, 0, 30]) },
      { projectId: "p2", usage: usage([2, 4, 0], [20, 40, 0]) },
    ]);

    expect(sumDays(body)).toEqual([
      { sends: 3, tokens: 30 },
      { sends: 4, tokens: 40 },
      { sends: 3, tokens: 30 },
    ]);
  });

  test("makes Monday-first week columns with a partial last column", () => {
    const days = dayStrings("2026-03-02", 176);
    const rows = usage(days.map((_, index) => index));
    const columns = weekColumns(days, rows, sendsPopulation(rows));

    expect(columns).toHaveLength(26);
    expect(columns[0].map((value) => value.day)).toEqual(days.slice(0, 7));
    expect(columns.at(-1)).toHaveLength(1);
    expect(columns.at(-1)?.[0].day).toBe(days.at(-1));
  });

  test("the 13-column slice starts on a Monday", () => {
    const days = dayStrings("2026-03-02", 176);
    const body = answer(days, [
      { projectId: "p1", usage: usage(days.map(() => 0)) },
    ]);
    const model = activityModel(body);

    const narrow = lastWeekColumns(model.columns, 13);
    expect(narrow).toHaveLength(13);
    expect(narrow[0][0].day).toBe("2026-06-01");
  });

  test("fits as many weeks as a width holds, 13 to the window's", () => {
    // a week is at least 14px and 3px of gap
    expect(fitWeeks(1100, 53)).toBe(53);
    expect(fitWeeks(600, 53)).toBe(35);
    expect(fitWeeks(290, 53)).toBe(17);
    expect(fitWeeks(100, 53)).toBe(13);
    expect(fitWeeks(1100, 26)).toBe(26);
    expect(fitWeeks(100, 5)).toBe(5);
  });

  test("a project's share of an answer sums its own days", () => {
    const days = dayStrings("2026-09-14", 2);
    const body = answer(
      days,
      [
        { projectId: "p1", usage: usage([1, 2], [10, 20]) },
        { projectId: "p2", usage: usage([5, 0], [50, 0]) },
      ],
      { sends: 8, tokens: 80 },
    );
    const mine = projectAnswer(body, "p1");
    expect(mine.projects).toEqual([body.projects[0]]);
    expect(mine.total).toEqual({ sends: 3, tokens: 30 });
    expect(mine.days).toBe(body.days);
    // a project the answer does not hold yet is all zeros
    expect(projectAnswer(body, "p9")).toMatchObject({
      total: { sends: 0, tokens: 0 },
      projects: [{ projectId: "p9", usage: usage([0, 0]) }],
    });
  });

  test("a strip takes the last requested days and shares the levels", () => {
    const days = dayStrings("2026-08-11", 35);
    const body = answer(days, [
      { projectId: "p1", usage: usage(days.map((_, index) => index)) },
    ]);
    const model = activityModel(body);
    const wide = projectStrip(body, "p1", model.population, 30);
    const narrow = projectStrip(body, "p1", model.population, 14);

    expect(wide).toHaveLength(30);
    expect(wide[0].day).toBe(days[5]);
    expect(narrow).toHaveLength(14);
    expect(narrow[0].day).toBe(days[21]);
    expect(narrow.at(-1)?.day).toBe(days.at(-1));
  });
});

describe("month labels", () => {
  const body = answer(dayStrings("2025-12-29", 182), [
    { projectId: "p1", usage: usage(Array(182).fill(0)) },
  ]);
  const columns = activityModel(body).columns;

  test("labels the months in 26 columns", () => {
    expect(monthLabels(columns)).toEqual([
      { column: 0, label: "Jan" },
      { column: 4, label: "Feb" },
      { column: 8, label: "Mar" },
      { column: 13, label: "Apr" },
      { column: 17, label: "May" },
      { column: 22, label: "Jun" },
    ]);
  });

  test("recomputes labels for the shown 13 columns", () => {
    expect(monthLabels(lastWeekColumns(columns, 13))).toEqual([
      { column: 0, label: "Apr" },
      { column: 4, label: "May" },
      { column: 9, label: "Jun" },
    ]);
  });

  test("drops the later label in a crowded pair", () => {
    const crowded: WeekColumn[] = [
      [cell("2026-01-01")],
      [cell("2026-01-08")],
      [cell("2026-02-01")],
    ];
    expect(monthLabels(crowded)).toEqual([{ column: 0, label: "Jan" }]);
  });

  test("keeps labels across a year end", () => {
    const days = dayStrings("2025-12-01", 35);
    const yearEnd = weekColumns(days, usage(Array(35).fill(0)), []);
    expect(monthLabels(yearEnd)).toEqual([
      { column: 0, label: "Dec" },
      { column: 4, label: "Jan" },
    ]);
  });
});

describe("selection and words", () => {
  test("arrow moves are clamped at both ends and past today", () => {
    expect(moveSelection(0, "ArrowUp", 20)).toBe(0);
    expect(moveSelection(3, "ArrowLeft", 20)).toBe(0);
    expect(moveSelection(20, "ArrowDown", 20)).toBe(20);
    expect(moveSelection(18, "ArrowRight", 20)).toBe(20);
    expect(moveSelection(8, "ArrowUp", 20)).toBe(7);
    expect(moveSelection(8, "ArrowDown", 20)).toBe(9);
    expect(moveSelection(8, "ArrowLeft", 20)).toBe(1);
    expect(moveSelection(8, "ArrowRight", 20)).toBe(15);
    expect(moveSelection(8, "Escape", 20)).toBeNull();
  });

  test("formats the selected day, totals, and accessible labels", () => {
    expect(dayHint({ day: "2026-09-12", sends: 23, tokens: 48_200 })).toBe(
      "12 Sep · 23 turns · 48.2K tokens",
    );
    expect(totalHint({ sends: 1_284, tokens: 2_100_000 })).toBe(
      "1,284 turns · 2.1M tokens",
    );
    expect(gridAriaLabel(1_284, 26)).toBe("1,284 turns in 26 weeks");
    expect(gridAriaLabel(1_284, 13)).toBe("1,284 turns in 13 weeks");
  });

  test("uses singular turn and counts a 30-day strip", () => {
    expect(dayHint({ day: "2026-09-12", sends: 1, tokens: 1 })).toBe(
      "12 Sep · 1 turn · 1 tokens",
    );
    expect(totalHint({ sends: 1, tokens: 900 })).toBe("1 turn · 900 tokens");
    const cells = dayStrings("2026-08-16", 30).map((day, index) => ({
      ...cell(day),
      sends: index === 0 ? 20 : index === 29 ? 22 : 0,
    }));
    expect(stripAriaLabel(cells)).toBe("42 turns in 30 days");
  });
});
