// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Activity card: turns per day over up to 53 weeks, a cell's shade its
// level, and the head's hint the total or the selected day. The weeks
// fill the card's width: a wider card shows more of the year, never
// bigger cells. The grid and its selection are exported for the
// project page's aside, which draws the recent weeks without labels.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  type DaysUsageResponse,
  type DayUsage,
  MAX_WEEKS,
} from "../../../shared/api/usage.ts";
import { onResize } from "../../lib/resize.ts";
import { RowsCard } from "../../ui/Rows.tsx";
import {
  type ActivityCell,
  type ActivityModel,
  dayHint,
  fitWeeks,
  gridAriaLabel,
  lastWeekColumns,
  monthLabels,
  moveSelection,
  type SelectionKey,
  totalHint,
  type WeekColumn,
} from "./Activity.model.ts";
import "./activity.css";

const KEYS = new Set<string>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
]);
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

// a selection a tap made stays until another tap; one the pointer made
// goes when the pointer leaves the grid
export type Selection = { index: number; by: "hover" | "tap" | "key" };

function cellClass(cell: ActivityCell, selected: boolean): string {
  return `activity-cell activity-level-${cell.level}${
    selected ? " activity-selected" : ""
  }`;
}

// the day a pointer event is over, from the cell's data attribute
function indexOf(event: Event): number | null {
  const cell = (event.target as Element | null)?.closest("[data-index]");
  return cell ? Number(cell.getAttribute("data-index")) : null;
}

// A slider over the window's days: one tab stop whose arrows move the
// selected day and whose value text is the hint, so a screen reader
// reads the day as it moves. The pointer is handled here too, off the
// cells, which stay plain shapes. Without labels it is the compact grid
// of the project page's aside: no months, no weekdays.
export function ActivityGrid({
  columns,
  offset,
  weeks,
  total,
  valueText,
  selection,
  labels = true,
}: {
  columns: WeekColumn[];
  // the index in the whole window of the first cell drawn
  offset: number;
  weeks: number;
  total: number;
  valueText: string;
  selection: Signal<Selection | null>;
  labels?: boolean;
}) {
  // the weekday labels take the first column and the months the first row
  const lead = labels ? 1 : 0;
  const last = offset + columns.reduce((n, c) => n + c.length, 0) - 1;
  const chosen =
    selection.value !== null &&
    selection.value.index >= offset &&
    selection.value.index <= last
      ? selection.value.index
      : null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!KEYS.has(event.key)) return;
    event.preventDefault();
    const next = moveSelection(chosen ?? last, event.key as SelectionKey, last);
    selection.value =
      next === null ? null : { index: Math.max(offset, next), by: "key" };
  };
  return (
    <div
      class={`activity-grid${labels ? "" : " activity-grid-compact"}`}
      role="slider"
      tabIndex={0}
      aria-label={gridAriaLabel(total, weeks)}
      aria-valuemin={offset}
      aria-valuemax={last}
      aria-valuenow={chosen ?? last}
      aria-valuetext={valueText}
      onFocus={(event) => {
        // the keyboard starts at today; a pointer's press focuses too,
        // and its click picks the day
        if ((event.currentTarget as Element).matches(":focus-visible")) {
          selection.value = { index: last, by: "key" };
        }
      }}
      onBlur={() => {
        if (selection.value?.by === "key") selection.value = null;
      }}
      onKeyDown={onKeyDown}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse") return;
        if (selection.value?.by === "tap") return;
        const index = indexOf(event);
        if (index === null || index === chosen) return;
        selection.value = { index, by: "hover" };
      }}
      onPointerLeave={() => {
        if (selection.value?.by === "hover") selection.value = null;
      }}
      onClick={(event) => {
        const index = indexOf(event);
        if (index === null) return;
        selection.value =
          selection.value?.by === "tap" && index === chosen
            ? null
            : { index, by: "tap" };
      }}
    >
      {labels &&
        monthLabels(columns).map((m) => (
          <span
            key={`m${m.column}`}
            class="activity-month"
            // a label near the end spans only the weeks left, since a span
            // past the last one adds grid tracks that shrink every cell
            style={{
              gridColumn: `${m.column + 2} / span ${Math.min(4, columns.length - m.column)}`,
              gridRow: 1,
            }}
          >
            {m.label}
          </span>
        ))}
      {labels &&
        WEEKDAYS.map((name, row) =>
          name === "" ? null : (
            <span
              key={name}
              class="activity-weekday"
              style={{ gridColumn: 1, gridRow: row + 2 }}
            >
              {name}
            </span>
          ),
        )}
      {columns.map((column, c) =>
        column.map((cell, row) => {
          const index = offset + c * 7 + row;
          return (
            <span
              key={cell.day}
              data-index={index}
              class={cellClass(cell, index === chosen)}
              style={{ gridColumn: c + 1 + lead, gridRow: row + 1 + lead }}
            />
          );
        }),
      )}
    </div>
  );
}

// The selected day, what lets it go (a tap outside the grid, a
// narrower card that no longer shows it, a new answer), and the hint
// for it or for the shown weeks.
export function useDaySelection(
  answer: DaysUsageResponse,
  model: ActivityModel,
  shown: WeekColumn[],
): { selection: Signal<Selection | null>; hint: string; total: DayUsage } {
  const selection = useSignal<Selection | null>(null);
  const offset = (model.columns.length - shown.length) * 7;

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (selection.value?.by !== "tap") return;
      const target = event.target as Element | null;
      if (target?.closest("[data-index]")) return;
      selection.value = null;
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [selection]);

  // a narrower card drops the weeks a selection was on; a tapped day
  // kept there would block hover and come back when the card widens
  useEffect(() => {
    if (selection.value !== null && selection.value.index < offset) {
      selection.value = null;
    }
  }, [offset, selection]);

  // a new answer is a new window, one day shorter at a Monday midnight,
  // so a day selected in the old one is let go
  useEffect(() => {
    selection.value = null;
  }, [answer, selection]);

  const chosen =
    selection.value !== null &&
    selection.value.index >= offset &&
    selection.value.index < answer.days.length
      ? selection.value.index
      : null;
  // the whole window's total counts a send across midnight once; a
  // part of it sums its days
  const total =
    offset === 0
      ? answer.total
      : shown.flat().reduce(
          (sum, cell) => ({
            sends: sum.sends + cell.sends,
            tokens: sum.tokens + cell.tokens,
          }),
          { sends: 0, tokens: 0 },
        );
  const hint =
    chosen === null
      ? totalHint(total)
      : dayHint({ day: answer.days[chosen], ...model.usage[chosen] });
  return { selection, hint, total };
}

// the width the weekday labels' column and its gap take from the weeks
const LABELS = 36;

// How many of the available weeks fit the card's width, measured
// before the first paint and again on a resize. Before the browser
// measures, as on the server and in a test, half a year.
function useFitWeeks(available: number) {
  const weeks = useSignal(Math.min(26, available));
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      // the grid, not the card: the card's padding is not the weeks'
      const grid = el.firstElementChild ?? el;
      weeks.value = fitWeeks(grid.clientWidth - LABELS, available);
    };
    measure();
    return onResize(el, measure);
  }, [available, weeks]);
  return { weeks: weeks.value, body };
}

function Legend() {
  return (
    <div class="activity-legend" aria-hidden="true">
      Less
      {[0, 1, 2, 3, 4].map((level) => (
        <span key={level} class={`activity-cell activity-level-${level}`} />
      ))}
      More
    </div>
  );
}

export function Activity({
  answer,
  model,
}: {
  answer: DaysUsageResponse;
  model: ActivityModel;
}) {
  const { weeks, body } = useFitWeeks(model.columns.length);
  const shown = lastWeekColumns(model.columns, weeks);
  const offset = (model.columns.length - shown.length) * 7;
  const { selection, hint, total } = useDaySelection(answer, model, shown);

  return (
    <RowsCard label="Activity" hint={hint} live>
      <div class="activity-body" ref={body}>
        <ActivityGrid
          columns={shown}
          offset={offset}
          weeks={shown.length}
          total={total.sends}
          valueText={hint}
          selection={selection}
        />
        <Legend />
      </div>
    </RowsCard>
  );
}

// The cells while an answer loads, pulsing week after week, with the
// labels the loaded grid draws, so the answer lands where the ghost was.
export function GhostGrid({
  weeks,
  labels = true,
}: {
  weeks: number;
  labels?: boolean;
}) {
  const lead = labels ? 1 : 0;
  return (
    <div
      class={`activity-grid${labels ? "" : " activity-grid-compact"}`}
      aria-hidden="true"
    >
      {labels && (
        <span class="activity-month" style={{ gridColumn: 2, gridRow: 1 }}>
          {"\u00a0"}
        </span>
      )}
      {labels &&
        WEEKDAYS.map((name, row) =>
          name === "" ? null : (
            <span
              key={name}
              class="activity-weekday"
              style={{ gridColumn: 1, gridRow: row + 2 }}
            >
              {name}
            </span>
          ),
        )}
      {Array.from({ length: weeks }, (_, c) =>
        WEEKDAYS.map((_, row) => (
          <span
            key={`${c}-${row}`}
            class="activity-cell activity-ghost"
            style={{
              gridColumn: c + 1 + lead,
              gridRow: row + 1 + lead,
              "--ghost": c,
            }}
          />
        )),
      )}
    </div>
  );
}

// The card while the year loads, measured as the loaded card is, so the
// rows under it stay put.
export function ActivityGhost() {
  const { weeks, body } = useFitWeeks(MAX_WEEKS);
  return (
    <RowsCard label="Activity">
      <div
        class="activity-body"
        ref={body}
        role="status"
        aria-label="Loading activity"
      >
        <GhostGrid weeks={weeks} />
        <Legend />
      </div>
    </RowsCard>
  );
}
