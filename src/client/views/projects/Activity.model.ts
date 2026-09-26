// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The activity chart's calendar-free shape and words. Day strings stay
// calendar dates from the server, never instants in the host's timezone.

import type { DaysUsageResponse, DayUsage } from "../../../shared/api/usage.ts";
import { count } from "../../lib/format.ts";

// the fewest weeks the card shows, and the narrowest a cell may get
// before a week is dropped: the weeks fill the card's width, so a wide
// screen shows more of the year rather than bigger cells
const MIN_WEEKS = 13;
const MIN_CELL = 14;
const CELL_GAP = 3;
// two weeks: a row has room for a few spaced squares, not a month of bars
export const STRIP_DAYS = 14;

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export type ActivityCell = DayUsage & {
  day: string;
  level: ActivityLevel;
};

export type WeekColumn = ActivityCell[];

type MonthLabel = {
  column: number;
  label: string;
};

export type ActivityModel = {
  usage: DayUsage[];
  population: number[];
  // every project's non-zero days: the strips rank against each other,
  // not against the summed days, which one project alone never reaches
  rowPopulation: number[];
  columns: WeekColumn[];
};

export type SelectionKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Escape";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const turnNumber = new Intl.NumberFormat("en-US");

export function sumDays(
  answer: Pick<DaysUsageResponse, "days" | "projects">,
): DayUsage[] {
  return answer.days.map((_, index) => {
    let sends = 0;
    let tokens = 0;
    for (const project of answer.projects) {
      sends += project.usage[index].sends;
      tokens += project.usage[index].tokens;
    }
    return { sends, tokens };
  });
}

// ascending, so a level is a binary search: a strip cell per project
// row would otherwise scan every project's year
export function sendsPopulation(usage: readonly DayUsage[]): number[] {
  return usage
    .map((day) => day.sends)
    .filter((sends) => sends !== 0)
    .sort((a, b) => a - b);
}

export function activityLevel(
  sends: number,
  population: readonly number[],
): ActivityLevel {
  if (sends === 0) return 0;
  if (population.length === 0) return 1;
  // how many are at most sends: the first index holding more
  let low = 0;
  let high = population.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (population[mid] <= sends) low = mid + 1;
    else high = mid;
  }
  const rank = low;
  return Math.max(
    1,
    Math.ceil((4 * rank) / population.length),
  ) as ActivityLevel;
}

function cellsOf(
  days: readonly string[],
  usage: readonly DayUsage[],
  population: readonly number[],
): ActivityCell[] {
  return days.map((day, index) => ({
    day,
    sends: usage[index].sends,
    tokens: usage[index].tokens,
    level: activityLevel(usage[index].sends, population),
  }));
}

export function weekColumns(
  days: readonly string[],
  usage: readonly DayUsage[],
  population: readonly number[],
): WeekColumn[] {
  const cells = cellsOf(days, usage, population);
  const columns: WeekColumn[] = [];
  for (let index = 0; index < cells.length; index += 7) {
    columns.push(cells.slice(index, index + 7));
  }
  return columns;
}

export function lastWeekColumns(
  columns: readonly WeekColumn[],
  length: number,
): WeekColumn[] {
  return columns.slice(-length);
}

// how many weeks fit a width, the weekday labels' column taken out
export function fitWeeks(width: number, available: number): number {
  const weeks = Math.floor((width + CELL_GAP) / (MIN_CELL + CELL_GAP));
  return Math.max(Math.min(MIN_WEEKS, available), Math.min(weeks, available));
}

export function activityModel(
  answer: Pick<DaysUsageResponse, "days" | "projects">,
): ActivityModel {
  const usage = sumDays(answer);
  const population = sendsPopulation(usage);
  const columns = weekColumns(answer.days, usage, population);
  return {
    usage,
    population,
    rowPopulation: sendsPopulation(
      answer.projects.flatMap((project) => project.usage),
    ),
    columns,
  };
}

// One project's share of an answer, as an answer of its own: its days,
// a total that sums them (the server's counts every project), and zeros
// for a project the answer does not hold yet.
export function projectAnswer(
  answer: DaysUsageResponse,
  projectId: string,
): DaysUsageResponse {
  const entry = answer.projects.find((p) => p.projectId === projectId) ?? {
    projectId,
    usage: answer.days.map(() => ({ sends: 0, tokens: 0 })),
  };
  const total = entry.usage.reduce(
    (sum, day) => ({
      sends: sum.sends + day.sends,
      tokens: sum.tokens + day.tokens,
    }),
    { sends: 0, tokens: 0 },
  );
  return { ...answer, total, projects: [entry] };
}

export function projectStrip(
  answer: Pick<DaysUsageResponse, "days" | "projects">,
  projectId: string,
  population: readonly number[],
  length = STRIP_DAYS,
): ActivityCell[] {
  const start = Math.max(0, answer.days.length - length);
  const days = answer.days.slice(start);
  const project = answer.projects.find(
    (entry) => entry.projectId === projectId,
  );
  const usage =
    project?.usage.slice(start) ?? days.map(() => ({ sends: 0, tokens: 0 }));
  return cellsOf(days, usage, population);
}

function dayParts(day: string): { day: number; month: number } {
  const parts = day.split("-");
  return { day: Number(parts[2]), month: Number(parts[1]) };
}

export function monthLabels(columns: readonly WeekColumn[]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  for (let column = 0; column < columns.length; column++) {
    const first = columns[column].find((cell) => dayParts(cell.day).day === 1);
    if (first === undefined) continue;
    const previous = labels.at(-1);
    if (previous !== undefined && column - previous.column < 4) continue;
    labels.push({ column, label: MONTHS[dayParts(first.day).month - 1] });
  }
  return labels;
}

export function moveSelection(
  index: number,
  key: SelectionKey,
  lastIndex: number,
): number | null {
  if (key === "Escape") return null;
  // columns are weeks and rows are weekdays, so across is a week
  const distance =
    key === "ArrowLeft"
      ? -7
      : key === "ArrowRight"
        ? 7
        : key === "ArrowUp"
          ? -1
          : 1;
  return Math.max(0, Math.min(lastIndex, index + distance));
}

function turns(value: number): string {
  return `${turnNumber.format(value)} ${value === 1 ? "turn" : "turns"}`;
}

export function dayHint(
  day: Pick<ActivityCell, "day" | "sends" | "tokens">,
): string {
  const parts = dayParts(day.day);
  return `${parts.day} ${MONTHS[parts.month - 1]} · ${turns(day.sends)} · ${count(day.tokens)} tokens`;
}

export function totalHint(total: DayUsage): string {
  return `${turns(total.sends)} · ${count(total.tokens)} tokens`;
}

export function gridAriaLabel(sends: number, weeks: number): string {
  return `${turns(sends)} in ${weeks} weeks`;
}

export function stripAriaLabel(cells: readonly ActivityCell[]): string {
  const sends = cells.reduce((total, cell) => total + cell.sends, 0);
  return `${turns(sends)} in ${cells.length} days`;
}
